#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// Mock LLM Server for health-router E2E Fallback Test
// ═══════════════════════════════════════════════════════════════
//
// 根据 request body 中的 model 字段决定响应：
//   - FAIL_MODEL (默认 "deepseek-v4-flash") → 返回 429 Rate Limit（前 MAX_FAILURES 次）
//   - 其他 model → 返回 200 正常 streaming 响应
//
// 环境变量:
//   FAIL_MODEL  - 要模拟失败的模型名（默认 "deepseek-v4-flash"）
//
// 用法: node mock-llm-for-e2e.mjs [port]
// 默认端口: 18888

import { createServer } from "node:http";

const PORT = parseInt(process.argv[2] || "18888", 10);
const FAIL_MODEL = process.env.FAIL_MODEL || "deepseek-v4-flash";
const MAX_FAILURES = 15; // 前 N 次对 FAIL_MODEL 的请求返回 429

let failCount = 0;
let successCount = 0;
const requestLog = [];

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

function makeStreamingResponse(res, model, text) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  // SSE: 发送 content chunk
  const chunk = {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [
      {
        index: 0,
        delta: { role: "assistant", content: text },
        finish_reason: null,
      },
    ],
  };
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);

  // SSE: 发送 finish chunk
  const done = {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: "stop",
      },
    ],
  };
  res.write(`data: ${JSON.stringify(done)}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

function makeNonStreamingResponse(res, model, text) {
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  const response = {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  };
  res.end(JSON.stringify(response));
}

function make429(res) {
  res.writeHead(429, {
    "Content-Type": "application/json",
    "Retry-After": "5",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(
    JSON.stringify({
      error: {
        message: "429 已达到 5 小时的使用上限，请稍后再试",
        type: "rate_limit_error",
        code: 429,
      },
    }),
  );
}

const server = createServer((req, res) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    });
    res.end();
    return;
  }

  // 收集 request body
  let body = "";
  req.on("data", (chunk) => (body += chunk.toString()));
  req.on("end", () => {
    let parsed = {};
    try {
      parsed = body ? JSON.parse(body) : {};
    } catch {
      parsed = {};
    }

    const model = parsed.model || "unknown";
    const stream = parsed.stream !== false; // 默认 streaming
    const entry = {
      time: new Date().toISOString(),
      method: req.method,
      url: req.url,
      model,
      stream,
    };

    // ─── /v1/chat/completions ───
    if (req.url === "/v1/chat/completions" || req.url === "/chat/completions") {
      if (model === FAIL_MODEL && failCount < MAX_FAILURES) {
        failCount++;
        entry.response = 429;
        requestLog.push(entry);
        log(
          `429 REJECT #${failCount}/${MAX_FAILURES} model=${model} stream=${stream}`,
        );
        make429(res);
        return;
      }

      // 正常响应（success-model 或 fail-model 超过失败次数后）
      successCount++;
      const text = `Fallback success! Model "${model}" responded. (mock request #${successCount})`;
      entry.response = 200;
      requestLog.push(entry);
      log(`200 OK model=${model} stream=${stream}`);

      if (stream) {
        makeStreamingResponse(res, model, text);
      } else {
        makeNonStreamingResponse(res, model, text);
      }
      return;
    }

    // ─── /v1/models ───
    if (req.url === "/v1/models" || req.url === "/models") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(
        JSON.stringify({
          object: "list",
          data: [
            { id: "fail-model", object: "model", owned_by: "mock" },
            { id: "success-model", object: "model", owned_by: "mock" },
          ],
        }),
      );
      requestLog.push({ ...entry, response: 200 });
      log(`200 OK models list`);
      return;
    }

    // ─── 其他路径 ───
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    requestLog.push({ ...entry, response: 404 });
    log(`404 NOT FOUND ${req.method} ${req.url}`);
  });
});

server.listen(PORT, "127.0.0.1", () => {
  log(`Mock LLM Server started on http://127.0.0.1:${PORT}`);
  log(`  ${FAIL_MODEL} → 429 Rate Limit (first ${MAX_FAILURES} requests)`);
  log(`  Other models  → 200 OK streaming`);
  log(``);
});

// 优雅退出
process.on("SIGINT", () => {
  log(`\nMock Server shutting down.`);
  log(`Stats: ${failCount} failures served, ${successCount} successes served.`);
  log(`Request log (${requestLog.length} entries):`);
  for (const e of requestLog) {
    log(
      `  ${e.time} ${e.method} ${e.url} model=${e.model} → ${e.response}`,
    );
  }
  process.exit(0);
});

// 导出统计信息（供测试脚本查询）
server.on("request", () => {});
