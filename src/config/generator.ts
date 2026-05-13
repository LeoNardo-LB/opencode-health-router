import * as fs from "fs"
import * as path from "path"
import type { Logger } from "../logging/logger.js"
import {
  DEFAULT_ENABLED,
  DEFAULT_FAILURE_PENALTY,
  DEFAULT_PRIMARY_RECOVERY_INTERVAL_MS,
  DEFAULT_PRIMARY_RECOVERY_BONUS,
  DEFAULT_PRIMARY_SUCCESS_BEHAVIOR,
  DEFAULT_FALLBACK_RECOVERY_INTERVAL_MS,
  DEFAULT_FALLBACK_RECOVERY_BONUS,
  DEFAULT_FALLBACK_SUCCESS_BONUS,
  DEFAULT_MAX_RETRIES,
  DEFAULT_LOG_LEVEL,
} from "./defaults.js"

/**
 * 从 opencode.jsonc 的 agent 配置中提取 agent 名称列表（排除 hidden/系统 agent）
 */
function extractAgentNames(opencodeConfig: unknown): string[] {
  if (!opencodeConfig || typeof opencodeConfig !== "object" || !("agent" in opencodeConfig)) return []
  const agents = (opencodeConfig as Record<string, Record<string, { hidden?: boolean; model?: string }>>).agent
  if (!agents || typeof agents !== "object") return []

  const names: string[] = []
  for (const [name, cfg] of Object.entries(agents)) {
    // 跳过 hidden agent（compaction, title, summary 等）
    if (cfg?.hidden) continue
    names.push(name)
  }
  return names
}

/**
 * 生成带注释的 JSONC 配置模板
 */
function buildTemplate(agentNames: string[]): string {
  const agentEntries = agentNames.length > 0
    ? agentNames.map(name => `    "${name}": { "fallbackModels": [] }`).join(",\n")
    : `    "build": { "fallbackModels": [] }`

  return `{
  // ═══════════════════════════════════════════════════════════════
  // Model Fallback Plugin — 自动模型降级插件
  // ═══════════════════════════════════════════════════════════════
  //
  // 运行机制:
  //   本插件通过 OpenCode 的 chat.message 和 event 两个钩子介入请求流程。
  //   所有模型共享 0-100 健康分，分数高的优先使用。
  //
  // 介入点:
  //   ① Preemptive (chat.message) — 请求发送前，按健康分自动选最高分模型
  //   ② Reactive   (event)        — 请求失败后，执行 abort → revert → prompt 切换到 fallback
  //   ③ 成功记录    (event)        — 监听 message.updated 事件，成功则恢复健康分
  //   ④ 定时回血    (setInterval)  — 每 30s 检查一次，满足间隔则恢复健康分
  //
  // 健康分规则:
  //   初始 100 分 → 失败 -${DEFAULT_FAILURE_PENALTY} → 主模型成功回 100 / 备模型成功 +${DEFAULT_FALLBACK_SUCCESS_BONUS}
  //   主模型闲置 ${DEFAULT_PRIMARY_RECOVERY_INTERVAL_MS / 60_000}min +${DEFAULT_PRIMARY_RECOVERY_BONUS} / 备模型闲置 ${DEFAULT_FALLBACK_RECOVERY_INTERVAL_MS / 60_000}min +${DEFAULT_FALLBACK_RECOVERY_BONUS}
  //
  // 配置说明:
  //   agents 中为每个 agent 配置 fallback 模型链，格式 "providerID/modelID"
  //   "*" 为通配符兜底，未匹配的 agent 走此配置
  //   不存在此文件时，插件使用内置默认值运行（agents 仅有通配符空链）
  // ═══════════════════════════════════════════════════════════════

  // 总开关，false 时插件完全停用
  "enabled": ${DEFAULT_ENABLED},

  // ═══════════════════════════════════════════════════════════════
  // 错误分类规则（用户自定义，按顺序优先匹配）
  // ═══════════════════════════════════════════════════════════════
  //
  //   以下内置规则始终生效，无需在此配置：
  //     429 → rate_limit      402 → quota_exceeded
  //     5xx → 5xx             529 → overloaded
  //     "已达到+使用上限" → rate_limit   "timeout" → timeout  等
  //
  //   此处的规则会优先于内置规则匹配，可用于：
  //     • 添加厂商特定的错误 pattern
  //     • 覆盖内置分类（如把 429 改名为 my_rate_limit）
  //
  //   规则字段:
  //     statusCodes — 消息以 HTTP 码开头时匹配（精确提取 ^\\d{3}）
  //     patterns    — 关键词匹配，% 是通配符，多项为 AND
  //     category    — rate_limit | quota_exceeded | 5xx | overloaded | timeout
  //
  "classification": {
    "rules": [
      // 在此添加你的自定义规则 ↓
      // { "statusCodes": [429], "category": "rate_limit" },
      // { "patterns": ["my provider error"], "category": "rate_limit" },
      // { "patterns": ["%已达到%使用上限%"], "category": "rate_limit" }
    ]
  },

  // 健康分参数（一般无需修改）
  "healthScore": {
    "failurePenalty": ${DEFAULT_FAILURE_PENALTY},    // 每次失败扣分
    "primary": {
      "recoveryIntervalMs": ${DEFAULT_PRIMARY_RECOVERY_INTERVAL_MS},  // 主模型回血间隔 ${DEFAULT_PRIMARY_RECOVERY_INTERVAL_MS / 60_000}min
      "recoveryBonus": ${DEFAULT_PRIMARY_RECOVERY_BONUS},            // 主模型每次回血量
      "successBehavior": "${DEFAULT_PRIMARY_SUCCESS_BEHAVIOR}"       // 主模型成功后直接回满 100
    },
    "fallback": {
      "recoveryIntervalMs": ${DEFAULT_FALLBACK_RECOVERY_INTERVAL_MS},  // 备模型回血间隔 ${DEFAULT_FALLBACK_RECOVERY_INTERVAL_MS / 60_000}min
      "recoveryBonus": ${DEFAULT_FALLBACK_RECOVERY_BONUS},             // 备模型每次回血量
      "successBonus": ${DEFAULT_FALLBACK_SUCCESS_BONUS}               // 备模型成功后加分
    }
  },

  // 重试策略：OpenCode 自行重试 maxRetries 次后，插件接管切换
  "retryPolicy": {
    "maxRetries": ${DEFAULT_MAX_RETRIES}
  },

  // ─── Agent 降级链 ───
  // 为每个 agent 配置 fallback 模型，格式 "providerID/modelID"
  // 请将 [] 替换为你的 fallback 模型列表，如:
  //   "fallbackModels": ["deepseek/deepseek-v4-pro", "deepseek/deepseek-v4-flash"]
  "agents": {
${agentEntries},
    "*": { "fallbackModels": [] }    // 通配符兜底
  },

  // 日志级别: debug | info | warn | error
  // debug 可看到所有决策过程，warn 只看警告和错误
  "logging": {
    "level": "${DEFAULT_LOG_LEVEL}"
  }
}
`
}

/**
 * 当配置文件不存在时，生成带注释的模板
 * @returns 生成的文件路径，或 null 表示生成失败
 */
export function generateTemplate(
  logger: Logger,
  opencodeConfig: unknown | undefined,
  configDir: string,
): string | null {
  // 模板生成到 OpenCode 全局配置目录，与项目无关
  const targetDir = configDir
  const targetFile = path.join(targetDir, "health-router.jsonc")

  // 已存在则不覆盖
  if (fs.existsSync(targetFile)) return null

  try {
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true })
    }

    const agentNames = extractAgentNames(opencodeConfig)
    const template = buildTemplate(agentNames)
    fs.writeFileSync(targetFile, template, "utf-8")
    logger.info("config.template_generated", { path: targetFile })
    return targetFile
  } catch (err) {
    logger.error("config.template_failed", { path: targetFile, error: String(err) })
    return null
  }
}
