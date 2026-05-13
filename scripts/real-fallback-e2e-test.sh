#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
# health-router Reactive Fallback E2E 测试
# ═══════════════════════════════════════════════════════════════════
#
# 测试流程：
#   1. 备份全局 opencode.jsonc，临时注入 mock-test provider + test-fallback agent
#   2. 启动 Mock LLM Server（对 fail-model 返回 429，对 success-model 返回 200）
#   3. 在临时目录创建 health-router 项目级配置（fallback 链）
#   4. 启动 OpenCode serve（加载 health-router 插件）
#   5. 通过 opencode run 发送消息触发请求
#   6. 检查 health-router 日志验证 reactive fallback 是否触发
#   7. 恢复全局 opencode.jsonc
#
# 前置条件：
#   - opencode CLI 在 PATH 中
#   - health-router 插件已构建（dist/index.bundle.js 存在）
#   - 全局 ~/.config/opencode/opencode.jsonc 中已注册 health-router 插件
#   - node >= 18
#
# 用法: bash scripts/real-fallback-e2e-test.sh [--keep]
#   --keep  保留测试目录和 serve 进程，方便手动调试
# ═══════════════════════════════════════════════════════════════════

set -euo pipefail

# ─── 配置 ─────────────────────────────────────────────────────────
MOCK_PORT=18888
SERVE_PORT=19998
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TEST_DIR=$(mktemp -d /tmp/health-router-e2e-XXXXXX)
MOCK_LOG="/tmp/health-router-e2e-mock.log"
SERVE_LOG="/tmp/health-router-e2e-serve.log"
HR_LOG="$HOME/.local/share/opencode/logs/health-router.log"
RUN_LOG="/tmp/health-router-e2e-run.log"
OPENCODE_CONFIG="$HOME/.config/opencode/opencode.jsonc"
OPENCODE_BACKUP="/tmp/health-router-e2e-opencode-backup.jsonc"
KEEP=false

# 解析参数
for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=true ;;
  esac
done

# ─── 颜色 ─────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

pass() { echo -e "${GREEN}✅ $1${NC}"; }
fail() { echo -e "${RED}❌ $1${NC}"; }
info() { echo -e "${CYAN}ℹ️  $1${NC}"; }
warn() { echo -e "${YELLOW}⚠️  $1${NC}"; }
header() { echo -e "\n${CYAN}═══ $1 ═══${NC}"; }

# ─── PID 追踪 ─────────────────────────────────────────────────────
MOCK_PID=""
SERVE_PID=""

cleanup() {
  # 恢复全局 opencode.jsonc（无论何种退出方式）
  if [ -f "$OPENCODE_BACKUP" ]; then
    cp "$OPENCODE_BACKUP" "$OPENCODE_CONFIG"
    info "全局 opencode.jsonc 已恢复"
    rm -f "$OPENCODE_BACKUP"
  fi

  if [ "$KEEP" = true ]; then
    echo ""
    info "保留模式: 未清理测试资源"
    info "测试目录: $TEST_DIR"
    info "Mock PID: $MOCK_PID (log: $MOCK_LOG)"
    info "Serve PID: $SERVE_PID (log: $SERVE_LOG)"
    info "清理命令: kill $MOCK_PID $SERVE_PID 2>/dev/null; rm -rf $TEST_DIR"
    return
  fi
  echo ""
  info "清理测试资源..."
  kill $MOCK_PID 2>/dev/null && info "Mock Server 已停止" || true
  kill $SERVE_PID 2>/dev/null && info "OpenCode Serve 已停止" || true
  # 给 serve 进程一点时间优雅退出
  sleep 1
  kill -9 $MOCK_PID 2>/dev/null || true
  kill -9 $SERVE_PID 2>/dev/null || true
  rm -rf "$TEST_DIR"
  info "清理完成"
}
trap cleanup EXIT

# ─── 前置检查 ─────────────────────────────────────────────────────
header "前置检查"

if ! command -v opencode &>/dev/null; then
  fail "opencode CLI 不在 PATH 中"
  exit 1
fi
pass "opencode CLI: $(opencode --version 2>/dev/null || echo 'version unknown')"

if [ ! -f "$PROJECT_DIR/dist/index.bundle.js" ]; then
  fail "health-router 插件未构建: $PROJECT_DIR/dist/index.bundle.js 不存在"
  info "请先运行: cd $PROJECT_DIR && npm run build"
  exit 1
fi
pass "health-router 插件已构建"

if ! node -e "console.log(process.version)" &>/dev/null; then
  fail "node 不可用"
  exit 1
fi
pass "node: $(node --version)"

if [ ! -f "$OPENCODE_CONFIG" ]; then
  fail "全局 opencode 配置不存在: $OPENCODE_CONFIG"
  exit 1
fi
pass "全局 opencode 配置: $OPENCODE_CONFIG"

# 备份 health-router 日志（在测试前记录当前行数，之后只检查新增内容）
HR_LOG_LINES_BEFORE=0
if [ -f "$HR_LOG" ]; then
  HR_LOG_LINES_BEFORE=$(wc -l < "$HR_LOG")
fi
info "health-router 日志: $HR_LOG (已有 ${HR_LOG_LINES_BEFORE} 行)"

# ─── 步骤 1: 注入测试配置到全局 opencode.jsonc ────────────────────
header "注入测试 Provider 到全局配置"

# 备份原始配置
cp "$OPENCODE_CONFIG" "$OPENCODE_BACKUP"
pass "原始 opencode.jsonc 已备份到 $OPENCODE_BACKUP"

# 创建临时 Node.js 注入脚本
INJECT_SCRIPT="/tmp/health-router-e2e-inject.mjs"
cat > "$INJECT_SCRIPT" << 'INJECT_EOF'
import { readFileSync, writeFileSync } from "node:fs";

const configPath = process.argv[2];
const mockPort = process.argv[3];

// 读取原始配置（手动处理 JSONC）
const raw = readFileSync(configPath, "utf-8");
let cleaned = raw
  .replace(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|\/\/.*/g, (_, str) => str || "")
  .replace(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|\/\*[\s\S]*?\*\//g, (_, str) => str || "")
  .replace(/,\s*([}\]])/g, "$1");

const config = JSON.parse(cleaned);

// ═══════════════════════════════════════════════════════════════
// 关键发现: OpenCode 只识别内置的 provider ID（如 deepseek、openai 等）
// 不能创建全新的 provider ID。
// 方案: 修改已有 deepseek provider 的 baseURL 指向 Mock Server
// ═══════════════════════════════════════════════════════════════

// 修改 deepseek provider 的 baseURL 指向本地 Mock Server
if (!config.provider) config.provider = {};
config.provider["deepseek"] = {
  npm: "@ai-sdk/openai-compatible",
  name: "DeepSeek (E2E Mock)",
  options: {
    baseURL: "http://127.0.0.1:" + mockPort + "/v1",
    apiKey: "test-key-for-e2e",
    timeout: 30000
  }
};

// 注入 test-fallback agent
// 使用 deepseek/deepseek-v4-flash 作为主模型（Mock Server 会返回 429）
if (!config.agent) config.agent = {};
config.agent["test-fallback"] = {
  description: "E2E fallback test agent (auto-injected)",
  model: "deepseek/deepseek-v4-flash",
  temperature: 0,
  mode: "primary",
  steps: 1,
  prompt: "You are a test assistant. Reply with exactly OK."
};

writeFileSync(configPath, JSON.stringify(config, null, 2));
console.log("OK: modified deepseek baseURL and injected test-fallback agent");
INJECT_EOF

node "$INJECT_SCRIPT" "$OPENCODE_CONFIG" "$MOCK_PORT"
INJECT_EXIT=$?
rm -f "$INJECT_SCRIPT"

if [ $INJECT_EXIT -eq 0 ]; then
  pass "deepseek baseURL 已修改指向 Mock Server，test-fallback agent 已注入"
else
    fail "注入配置失败（可能 JSONC 解析出错）"
  exit 1
fi

# ─── 步骤 2: 创建测试目录和 health-router 配置 ────────────────────
header "创建测试配置"

info "测试目录: $TEST_DIR"
mkdir -p "$TEST_DIR/.opencode"

# health-router 项目级配置（优先级高于全局）
cat > "$TEST_DIR/.opencode/health-router.jsonc" << 'HR_EOF'
{
  // E2E 测试用的 health-router 配置
  "enabled": true,

  // 减少 maxRetries 使 fallback 更快触发
  // shouldIntervene(attempt, maxRetries) = attempt > maxRetries
  "retryPolicy": {
    "maxRetries": 2
  },

  "healthScore": {
    "failurePenalty": 25,
    "primary": {
      "recoveryIntervalMs": 60000,
      "recoveryBonus": 10,
      "successBehavior": "full"
    },
    "fallback": {
      "recoveryIntervalMs": 120000,
      "recoveryBonus": 5,
      "successBonus": 5
    }
  },

  // test-fallback agent 的主模型是 deepseek/deepseek-v4-flash（会收到 429）
  // fallback 到 deepseek/deepseek-v4-pro（会正常响应）
  // 两者都走 Mock Server，Mock Server 按 model 字段区分
  "agents": {
    "test-fallback": {
      "fallbackModels": ["deepseek/deepseek-v4-pro"]
    }
  },

  "logging": {
    "level": "debug"
  }
}
HR_EOF
pass "health-router.jsonc 已创建"
info "配置文件: $TEST_DIR/.opencode/health-router.jsonc"

# ─── 步骤 3: 启动 Mock LLM Server ────────────────────────────────
header "启动 Mock LLM Server"

node "$PROJECT_DIR/scripts/mock-llm-for-e2e.mjs" "$MOCK_PORT" > "$MOCK_LOG" 2>&1 &
MOCK_PID=$!
info "Mock Server PID: $MOCK_PID, 端口: $MOCK_PORT"

# 等待 Mock Server 启动
RETRIES=0
MAX_RETRIES=20
while ! curl -s "http://127.0.0.1:$MOCK_PORT/v1/models" >/dev/null 2>&1; do
  RETRIES=$((RETRIES + 1))
  if [ $RETRIES -ge $MAX_RETRIES ]; then
    fail "Mock Server 启动超时"
    cat "$MOCK_LOG"
    exit 1
  fi
  sleep 0.5
done
pass "Mock Server 已启动并响应"

# 验证 Mock Server 行为（使用 curl 验证）
# fail-model 映射为 deepseek-v4-flash
FAIL_RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "http://127.0.0.1:$MOCK_PORT/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"test"}],"stream":false}')
if [ "$FAIL_RESPONSE" = "429" ]; then
  pass "Mock Server 对 deepseek-v4-flash 返回 429"
else
  fail "Mock Server 对 deepseek-v4-flash 应返回 429，实际: $FAIL_RESPONSE"
  exit 1
fi

SUCCESS_RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "http://127.0.0.1:$MOCK_PORT/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4-pro","messages":[{"role":"user","content":"test"}],"stream":false}')
if [ "$SUCCESS_RESPONSE" = "200" ]; then
  pass "Mock Server 对 deepseek-v4-pro 返回 200"
else
  fail "Mock Server 对 deepseek-v4-pro 应返回 200，实际: $SUCCESS_RESPONSE"
  exit 1
fi

# ─── 步骤 4: 启动 OpenCode Serve ─────────────────────────────────
header "启动 OpenCode Serve"

info "启动 serve (端口 $SERVE_PORT)..."
opencode serve --port $SERVE_PORT --log-level DEBUG --print-logs > "$SERVE_LOG" 2>&1 &
SERVE_PID=$!
info "Serve PID: $SERVE_PID"

# 等待 Serve 启动
SERVE_RETRIES=0
SERVE_MAX_RETRIES=30
while ! curl -s "http://127.0.0.1:$SERVE_PORT/" >/dev/null 2>&1; do
  SERVE_RETRIES=$((SERVE_RETRIES + 1))
  if [ $SERVE_RETRIES -ge $SERVE_MAX_RETRIES ]; then
    fail "OpenCode Serve 启动超时 (${SERVE_MAX_RETRIES}s)"
    echo "--- Serve Log (最后 50 行) ---"
    tail -50 "$SERVE_LOG"
    exit 1
  fi
  sleep 1
done
pass "OpenCode Serve 已启动"

# 等待插件初始化
sleep 3

# ─── 步骤 5: 发送测试消息 ─────────────────────────────────────────
header "发送测试消息"

info "使用 test-fallback agent 发送消息..."
info "期望流程:"
info "  1. opencode run → serve 创建 session"
info "  2. chat.message hook → preemptive 检查（初始健康分100，不切换）"
info "  3. 请求到 Mock Server → fail-model 返回 429"
info "  4. OpenCode 重试 → 仍收到 429（最多 maxRetries=2 次）"
info "  5. attempt > maxRetries → 插件 reactive handler 接管"
info "  6. classify(rate_limit) → select fallback → abort → revert → prompt(success-model)"
info "  7. success-model 正常响应 200 → reactive.fallback_success"

# 使用 opencode run 发送消息
# --attach 连接到已启动的 serve
# --dir 指向测试目录（加载项目级 health-router 配置）
# --agent 指定测试 agent
# 使用 timeout 限制运行时间（防止无限重试）
timeout 60 opencode run \
  --attach "http://127.0.0.1:$SERVE_PORT" \
  --dir "$TEST_DIR" \
  --agent "test-fallback" \
  --format json \
  "Say hello" > "$RUN_LOG" 2>&1 || true

# 等待请求处理完成
# OpenCode 对 429 的重试间隔由 Retry-After header 控制（Mock Server 设置为 60s）
# 需要等待足够长时间让 OpenCode 完成重试周期
info "等待请求处理（可能需要数分钟，因为 429 重试间隔）..."
sleep 15

# ─── 步骤 6: 验证结果 ────────────────────────────────────────────
header "验证结果"

TOTAL_PASSED=0
TOTAL_FAILED=0

# 提取测试期间新增的日志内容
HR_TEST_LOG="/tmp/health-router-e2e-hr-excerpt.log"
if [ -f "$HR_LOG" ]; then
  tail -n +$((HR_LOG_LINES_BEFORE + 1)) "$HR_LOG" > "$HR_TEST_LOG" 2>/dev/null || true
else
  touch "$HR_TEST_LOG"
fi

echo ""
info "=== health-router 日志分析 ==="

# 检查 1: 配置是否被加载
if grep -q 'config.loaded' "$HR_TEST_LOG" 2>/dev/null; then
  CONFIG_PATH=$(grep 'config.loaded' "$HR_TEST_LOG" | tail -1 | grep -o '"path":"[^"]*"' || echo '?')
  pass "插件配置已加载: $CONFIG_PATH"
  TOTAL_PASSED=$((TOTAL_PASSED + 1))
else
  if grep -q 'plugin.started' "$HR_TEST_LOG" 2>/dev/null; then
    pass "插件已启动"
    TOTAL_PASSED=$((TOTAL_PASSED + 1))
  else
    fail "插件未启动或配置未加载"
    TOTAL_FAILED=$((TOTAL_FAILED + 1))
  fi
fi

# 检查 2: primary models 包含 deepseek/deepseek-v4-flash
if grep -q 'opencode.primary_models' "$HR_TEST_LOG" 2>/dev/null; then
  MODELS_LINE=$(grep 'opencode.primary_models' "$HR_TEST_LOG" | tail -1)
  if echo "$MODELS_LINE" | grep -q 'deepseek/deepseek-v4-flash'; then
    pass "deepseek/deepseek-v4-flash 被识别为 primary model"
    TOTAL_PASSED=$((TOTAL_PASSED + 1))
  else
    warn "deepseek/deepseek-v4-flash 未在 primaryModels 中"
    info "Primary models: $(echo "$MODELS_LINE" | grep -o '"models":\[.*\]' || echo '(解析失败)')"
  fi
fi

# 检查 3: preemptive hook 是否收到消息
if grep -q 'preemptive\.' "$HR_TEST_LOG" 2>/dev/null; then
  PREEMPT_LINE=$(grep 'preemptive\.' "$HR_TEST_LOG" | tail -1)
  AGENT=$(echo "$PREEMPT_LINE" | grep -o '"agent":"[^"]*"' || echo '?')
  SESSION=$(echo "$PREEMPT_LINE" | grep -o '"sessionID":"[^"]*"' || echo '?')
  pass "chat.message hook 收到消息: agent=$AGENT session=$SESSION"
  TOTAL_PASSED=$((TOTAL_PASSED + 1))
else
  warn "未检测到 preemptive 事件"
fi

# 检查 4: ⭐ Mock Server 收到了 deepseek-v4-flash 的请求（确认请求到达）
MOCK_429_COUNT=$(grep -c '429 REJECT.*deepseek-v4-flash' "$MOCK_LOG" 2>/dev/null || echo "0")
if [ "$MOCK_429_COUNT" -gt 0 ]; then
  pass "⭐ Mock Server 收到 $MOCK_429_COUNT 次 deepseek-v4-flash 请求并返回 429"
  TOTAL_PASSED=$((TOTAL_PASSED + 1))
else
  fail "Mock Server 未收到 deepseek-v4-flash 请求"
  TOTAL_FAILED=$((TOTAL_FAILED + 1))
fi

# 检查 5: retry 事件是否被检测到
if grep -q 'reactive.retry_event' "$HR_TEST_LOG" 2>/dev/null; then
  RETRY_LINES=$(grep 'reactive.retry_event' "$HR_TEST_LOG")
  pass "检测到 retry 事件:"
  echo "$RETRY_LINES" | while IFS= read -r line; do
    info "  $(echo "$line" | grep -o '"attempt":[0-9]*' || echo '?')"
  done
  TOTAL_PASSED=$((TOTAL_PASSED + 1))
else
  warn "未检测到 reactive.retry_event"
  warn "  可能原因: OpenCode 的 429 重试不通过 session.status/retry 事件传递"
  TOTAL_FAILED=$((TOTAL_FAILED + 1))
fi

# 检查 6: 错误分类
if grep -q 'reactive.category_branch' "$HR_TEST_LOG" 2>/dev/null; then
  CATEGORY=$(grep 'reactive.category_branch' "$HR_TEST_LOG" | tail -1 | grep -o '"category":"[^"]*"' || echo 'unknown')
  pass "错误已分类: $CATEGORY"
  TOTAL_PASSED=$((TOTAL_PASSED + 1))
fi

# 检查 7: 失败记录
if grep -q 'reactive.failure_recorded' "$HR_TEST_LOG" 2>/dev/null; then
  pass "失败已记录到 health store"
  TOTAL_PASSED=$((TOTAL_PASSED + 1))
fi

# 检查 8: ⭐ 核心指标 — reactive fallback 成功
if grep -q 'reactive.fallback_success' "$HR_TEST_LOG" 2>/dev/null; then
  FALLBACK_LINE=$(grep 'reactive.fallback_success' "$HR_TEST_LOG" | tail -1)
  FROM=$(echo "$FALLBACK_LINE" | grep -o '"from":"[^"]*"' || echo '?')
  TO=$(echo "$FALLBACK_LINE" | grep -o '"to":"[^"]*"' || echo '?')
  pass "⭐ Reactive fallback 成功触发!"
  pass "  模型切换: $FROM → $TO"
  TOTAL_PASSED=$((TOTAL_PASSED + 1))
else
  fail "⭐ 未检测到 reactive.fallback_success"
  warn "  这表明 health-router 的 reactive handler 未被 OpenCode 的事件触发"
  warn "  可能原因: OpenCode 的 retry 事件格式与 health-router 期望的不匹配"
  TOTAL_FAILED=$((TOTAL_FAILED + 1))
fi

# 检查 9: deepseek-v4-pro (fallback model) 是否收到请求
MOCK_SUCCESS=$(grep -c '200 OK model=deepseek-v4-pro' "$MOCK_LOG" 2>/dev/null || echo "0")
if [ "$MOCK_SUCCESS" -gt 0 ]; then
  pass "deepseek-v4-pro 收到 $MOCK_SUCCESS 次请求（fallback 路由成功）"
  TOTAL_PASSED=$((TOTAL_PASSED + 1))
fi

# 检查 10: 是否有错误
if grep -q 'reactive.prompt_failed' "$HR_TEST_LOG" 2>/dev/null; then
  fail "reactive prompt 执行失败"
  grep 'reactive.prompt_failed' "$HR_TEST_LOG"
  TOTAL_FAILED=$((TOTAL_FAILED + 1))
fi

# 检查 11: session.error 事件（OpenCode 的 429 处理）
if grep -q '"type":"session.error"' "$HR_TEST_LOG" 2>/dev/null; then
  ERROR_COUNT=$(grep -c '"type":"session.error"' "$HR_TEST_LOG" 2>/dev/null || echo "0")
  info "检测到 $ERROR_COUNT 个 session.error 事件（OpenCode 的 429 错误处理）"
fi

echo ""
info "=== health-router 日志分析 ==="

# 检查 1: 配置是否被加载
if grep -q 'config.loaded' "$HR_TEST_LOG" 2>/dev/null; then
  pass "插件配置已加载"
  TOTAL_PASSED=$((TOTAL_PASSED + 1))
else
  if grep -q 'plugin.started' "$HR_TEST_LOG" 2>/dev/null; then
    pass "插件已启动"
    TOTAL_PASSED=$((TOTAL_PASSED + 1))
  else
    fail "插件未启动或配置未加载"
    TOTAL_FAILED=$((TOTAL_FAILED + 1))
  fi
fi

# 检查 2: primary models 包含 deepseek/fail-model
if grep -q 'opencode.primary_models' "$HR_TEST_LOG" 2>/dev/null; then
  MODELS_LINE=$(grep 'opencode.primary_models' "$HR_TEST_LOG" | tail -1)
  if echo "$MODELS_LINE" | grep -q 'deepseek/deepseek-v4-flash'; then
    pass "deepseek/deepseek-v4-flash 被识别为 primary model"
    TOTAL_PASSED=$((TOTAL_PASSED + 1))
  else
    warn "deepseek/deepseek-v4-flash 未在 primaryModels 中"
    info "Primary models: $(echo "$MODELS_LINE" | grep -o '"models":\[.*\]' || echo '(解析失败)')"
  fi
fi

# 检查 3: preemptive hook 是否收到消息
if grep -q 'preemptive\.' "$HR_TEST_LOG" 2>/dev/null; then
  pass "chat.message hook 收到消息（preemptive 检查执行）"
  TOTAL_PASSED=$((TOTAL_PASSED + 1))
else
  warn "未检测到 preemptive 事件"
fi

# 检查 4: session.status 事件是否被接收
if grep -q '"type":"session.status"' "$HR_TEST_LOG" 2>/dev/null; then
  STATUS_COUNT=$(grep -c '"type":"session.status"' "$HR_TEST_LOG" 2>/dev/null || echo "0")
  info "收到 $STATUS_COUNT 个 session.status 事件"
fi

# 检查 5: retry 事件是否被检测到
if grep -q 'reactive.retry_event' "$HR_TEST_LOG" 2>/dev/null; then
  RETRY_LINES=$(grep 'reactive.retry_event' "$HR_TEST_LOG")
  pass "检测到 retry 事件:"
  echo "$RETRY_LINES" | while IFS= read -r line; do
    info "  $(echo "$line" | grep -o '"attempt":[0-9]*' || echo '?')"
  done
  TOTAL_PASSED=$((TOTAL_PASSED + 1))
else
  warn "未检测到 reactive.retry_event"
  TOTAL_FAILED=$((TOTAL_FAILED + 1))
fi

# 检查 6: 错误分类
if grep -q 'reactive.category_branch' "$HR_TEST_LOG" 2>/dev/null; then
  CATEGORY=$(grep 'reactive.category_branch' "$HR_TEST_LOG" | tail -1 | grep -o '"category":"[^"]*"' || echo 'unknown')
  pass "错误已分类: $CATEGORY"
  TOTAL_PASSED=$((TOTAL_PASSED + 1))
elif grep -q 'reactive.classify_miss' "$HR_TEST_LOG" 2>/dev/null; then
  fail "错误分类未命中（classify_miss）"
  grep 'reactive.classify_miss' "$HR_TEST_LOG" | tail -3
  TOTAL_FAILED=$((TOTAL_FAILED + 1))
fi

# 检查 7: 失败记录
if grep -q 'reactive.failure_recorded' "$HR_TEST_LOG" 2>/dev/null; then
  pass "失败已记录到 health store"
  TOTAL_PASSED=$((TOTAL_PASSED + 1))
else
  warn "未检测到 reactive.failure_recorded"
  TOTAL_FAILED=$((TOTAL_FAILED + 1))
fi

# 检查 8: ⭐ 核心指标 — reactive fallback 成功
if grep -q 'reactive.fallback_success' "$HR_TEST_LOG" 2>/dev/null; then
  FALLBACK_LINE=$(grep 'reactive.fallback_success' "$HR_TEST_LOG" | tail -1)
  FROM=$(echo "$FALLBACK_LINE" | grep -o '"from":"[^"]*"' || echo '?')
  TO=$(echo "$FALLBACK_LINE" | grep -o '"to":"[^"]*"' || echo '?')
  pass "⭐ Reactive fallback 成功触发!"
  pass "  模型切换: $FROM → $TO"
  TOTAL_PASSED=$((TOTAL_PASSED + 1))
else
  fail "⭐ 未检测到 reactive.fallback_success"
  TOTAL_FAILED=$((TOTAL_FAILED + 1))
fi

# 检查 9: 是否有 abort 操作
ABORT_COUNT=$(grep -c 'reactive' "$HR_TEST_LOG" 2>/dev/null || echo "0")
info "reactive 相关日志条目: $ABORT_COUNT"

# 检查 10: success-model(deepseek-v4-pro) 是否收到请求（通过 Mock Server 日志验证）
MOCK_SUCCESS=$(grep -c '200 OK model=deepseek-v4-pro' "$MOCK_LOG" 2>/dev/null || echo "0")
if [ "$MOCK_SUCCESS" -gt 0 ]; then
  pass "deepseek-v4-pro 收到 $MOCK_SUCCESS 次请求（fallback 路由成功）"
  TOTAL_PASSED=$((TOTAL_PASSED + 1))
else
  warn "deepseek-v4-pro 未收到请求"
  TOTAL_FAILED=$((TOTAL_FAILED + 1))
fi

# 检查 11: 是否有错误
if grep -q 'reactive.prompt_failed' "$HR_TEST_LOG" 2>/dev/null; then
  fail "reactive prompt 执行失败"
  grep 'reactive.prompt_failed' "$HR_TEST_LOG"
  TOTAL_FAILED=$((TOTAL_FAILED + 1))
fi

# ─── Mock Server 统计 ─────────────────────────────────────────────
echo ""
info "=== Mock Server 统计 ==="
MOCK_429_COUNT=$(grep -c '429 REJECT' "$MOCK_LOG" 2>/dev/null || echo "0")
MOCK_200_COUNT=$(grep -c '200 OK' "$MOCK_LOG" 2>/dev/null || echo "0")
info "429 响应 (deepseek-v4-flash): $MOCK_429_COUNT 次"
info "200 响应 (all models): $MOCK_200_COUNT 次"

# ─── 日志文件位置 ─────────────────────────────────────────────────
echo ""
info "=== 日志文件 ==="
info "Mock Server:  $MOCK_LOG"
info "Serve:        $SERVE_LOG"
info "Run 输出:     $RUN_LOG"
info "HR 日志:      $HR_LOG"
info "HR 测试片段:  $HR_TEST_LOG"

# ─── 汇总 ─────────────────────────────────────────────────────────
header "测试汇总"
echo -e "通过: ${GREEN}${TOTAL_PASSED}${NC}  失败: ${RED}${TOTAL_FAILED}${NC}"

if [ $TOTAL_FAILED -eq 0 ]; then
  pass "所有检查通过! Reactive fallback E2E 测试成功"
  exit 0
else
  fail "有 $TOTAL_FAILED 项检查未通过"
  echo ""
  info "=== 诊断分析 ==="
  
  # 分析根本原因
  if grep -q 'reactive.retry_event' "$HR_TEST_LOG" 2>/dev/null; then
    if grep -q 'reactive.no_cache_match' "$HR_TEST_LOG" 2>/dev/null; then
      warn "根本原因: reactive handler 因 no_cache_match 跳过了 fallback"
      warn "  - chat.message hook 收到的 input.model 为 null"
      warn "  - 导致 messageCache 为空（stackSize=0）"
      warn "  - reactive handler 无法匹配 cache 条目，跳过 fallback"
      warn "  这是 OpenCode 在 'opencode run' 模式下的行为特征"
      warn "  在正常交互模式（TUI）中，model 字段可能不为 null"
    elif grep -q 'reactive.retry_gate' "$HR_TEST_LOG" 2>/dev/null; then
      warn "所有 retry 事件都被 retry_gate 拦截（attempt <= maxRetries）"
    fi
  fi
  
  echo ""
  info "调试建议:"
  info "  1. 查看 HR 日志: tail -200 $HR_LOG"
  info "  2. 查看 Serve 日志: tail -200 $SERVE_LOG"
  info "  3. 查看 Run 输出: cat $RUN_LOG"
  info "  4. 查看 HR 测试片段: cat $HR_TEST_LOG"
  info "  5. 使用 --keep 保留测试环境重新运行"
  exit 1
fi
