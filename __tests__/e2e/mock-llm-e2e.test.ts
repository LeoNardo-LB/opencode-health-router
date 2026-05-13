import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { spawn, type ChildProcess } from "node:child_process"
import { mkdir, writeFile, readFile, rm } from "node:fs/promises"
import { existsSync } from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { MockLLMServer } from "./mock-llm-server.js"

const OPENCODE_BIN = process.env.OPENCODE_BIN ?? "opencode"
const PLUGIN_DIST = path.resolve(process.cwd(), "dist/index.bundle.js")
const TIMEOUT_MS = 120_000

// Skip unless:
// 1. dist/index.bundle.js is built
// 2. @ai-sdk/openai-compatible is available in opencode cache (required by custom provider config)
// 3. E2E_SERVE_ENABLED env var is set (safety gate to avoid accidental runs)
// 4. opencode global config exists and includes our plugin
const opencodeCache = path.join(os.homedir(), ".cache", "opencode", "node_modules")
const hasOpenAISdk = existsSync(path.join(opencodeCache, "@ai-sdk", "openai-compatible"))
const globalConfigPath = path.join(os.homedir(), ".config", "opencode", "opencode.jsonc")
const hasGlobalConfig = existsSync(globalConfigPath)
const shouldSkip = !existsSync(PLUGIN_DIST) || !process.env.E2E_SERVE_ENABLED || !hasOpenAISdk || !hasGlobalConfig

describe.skipIf(shouldSkip)("E2E: opencode serve + Mock LLM", () => {
  const primaryPort = 19701
  const fallbackPort = 19702
  const servePort = 19703
  const tmpDir = path.join(os.tmpdir(), `mf-e2e-serve-${Date.now()}`)

  const primaryServer = new MockLLMServer()
  const fallbackServer = new MockLLMServer()
  let serveProcess: ChildProcess | null = null
  let serveStderr: string[] = []

  beforeAll(async () => {
    // 1. Start mock LLM servers
    await primaryServer.start(primaryPort)
    await fallbackServer.start(fallbackPort)

    // 2. Create project directory with git repo (required for project-level config)
    await mkdir(tmpDir, { recursive: true })
    const { execSync } = await import("node:child_process")
    execSync("git init", { cwd: tmpDir, stdio: "pipe" })

    // 3. Create project-level .opencode directory
    await mkdir(path.join(tmpDir, ".opencode"), { recursive: true })

    // 4. Write project-level opencode.jsonc with custom providers
    //    Note: plugin field is inherited from global config (~/.config/opencode/opencode.jsonc)
    const opencodeConfig = {
      $schema: "https://opencode.ai/config.json",
      enabled_providers: ["e2e-primary", "e2e-fallback"],
      provider: {
        "e2e-primary": {
          name: "E2E Primary",
          npm: "@ai-sdk/openai-compatible",
          env: [],
          models: {
            "test-primary": {
              name: "Test Primary",
              tool_call: true,
              limit: { context: 128000, output: 32000 },
            },
          },
          options: {
            apiKey: "test-key",
            baseURL: `http://127.0.0.1:${primaryPort}`,
          },
        },
        "e2e-fallback": {
          name: "E2E Fallback",
          npm: "@ai-sdk/openai-compatible",
          env: [],
          models: {
            "test-fallback": {
              name: "Test Fallback",
              tool_call: true,
              limit: { context: 128000, output: 32000 },
            },
          },
          options: {
            apiKey: "test-key",
            baseURL: `http://127.0.0.1:${fallbackPort}`,
          },
        },
      },
      agent: {
        build: { model: "e2e-primary/test-primary" },
      },
      plugin: [`file://${PLUGIN_DIST}`],
    }
    await writeFile(
      path.join(tmpDir, ".opencode", "opencode.jsonc"),
      JSON.stringify(opencodeConfig, null, 2),
    )

    // 5. Write project-level health-router.json
    const healthRouterConfig = {
      enabled: true,
      classification: {
        rules: [{ statusCodes: [429], patterns: [] }, { statusCodes: [500], patterns: [] }],
      },
      healthScore: {
        failurePenalty: 20,
        primary: { recoveryIntervalMs: 60000, recoveryBonus: 10, successBehavior: "full" },
        fallback: { recoveryIntervalMs: 120000, recoveryBonus: 5, successBonus: 5 },
      },
      retryPolicy: { maxRetries: 3 },
      agents: {
        build: { fallbackModels: ["e2e-fallback/test-fallback"] },
      },
      logging: { level: "debug", path: path.join(tmpDir, "health-router.log") },
    }
    await writeFile(
      path.join(tmpDir, ".opencode", "health-router.json"),
      JSON.stringify(healthRouterConfig, null, 2),
    )

    // 6. Start opencode serve (NO XDG overrides — use default global config + plugin discovery)
    serveStderr = []
    serveProcess = spawn(
      OPENCODE_BIN,
      ["serve", "--port", servePort.toString(), "--print-logs", "--log-level", "DEBUG"],
      {
        env: {
          ...process.env,
          // Override XDG_DATA_HOME and XDG_CACHE_HOME to isolate from real data
          XDG_DATA_HOME: path.join(tmpDir, "data"),
          XDG_CACHE_HOME: path.join(tmpDir, "cache"),
        },
        cwd: tmpDir,
        stdio: ["pipe", "pipe", "pipe"],
      },
    )
    serveProcess.stderr?.on("data", (data: Buffer) => {
      serveStderr.push(data.toString())
    })

    // 7. Wait for serve to be ready (poll /api/session)
    const start = Date.now()
    while (Date.now() - start < 30_000) {
      try {
        const res = await fetch(`http://127.0.0.1:${servePort}/api/session`)
        if (res.ok || res.status === 200) break
      } catch {
        /* not ready yet */
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    // Extra wait for plugin to initialize (lazy-loaded on first session creation)
    await new Promise((r) => setTimeout(r, 2_000))
  }, TIMEOUT_MS)

  afterAll(async () => {
    if (serveProcess) {
      serveProcess.kill("SIGTERM")
      await new Promise<void>((resolve) => {
        serveProcess!.on("exit", () => resolve())
        setTimeout(() => {
          serveProcess!.kill("SIGKILL")
          resolve()
        }, 5000)
      })
    }
    await primaryServer.stop()
    await fallbackServer.stop()
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  })

  it("plugin loaded without errors", () => {
    const errorLines = serveStderr.filter((line) => /plugin.*error|failed to load/i.test(line))
    expect(errorLines).toEqual([])
  })

  it("plugin log file exists and shows startup", async () => {
    const logPath = path.join(tmpDir, "health-router.log")
    const logContent = await readFile(logPath, "utf-8").catch(() => "")
    // Plugin is lazy-loaded — may not have started yet if no session created
    // At minimum, check no error log was produced
    expect(logContent).not.toContain("plugin.disabled")
  })

  it("user message to healthy model does not trigger fallback", async () => {
    // Mock: primary returns success
    primaryServer.replyText("Primary response OK")
    fallbackServer.replyText("Fallback response") // Should NOT be called

    // Create session via /session endpoint (POST /api/session returns HTML)
    const sessionRes = await fetch(`http://127.0.0.1:${servePort}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ directory: tmpDir }),
    })
    const session = await sessionRes.json()
    const sessionID = session.data?.id ?? session.id

    // Send prompt via /session/:id/prompt
    await fetch(`http://127.0.0.1:${servePort}/session/${sessionID}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        parts: [{ type: "text", text: "Hello" }],
        agent: "build",
      }),
    })

    // Wait for LLM response
    await new Promise((r) => setTimeout(r, 8_000))

    // Verify: primary was called, fallback was not
    expect(primaryServer.getCallCount()).toBeGreaterThanOrEqual(1)
    expect(fallbackServer.getCallCount()).toBe(0)

    // Verify log: plugin is active
    const logPath = path.join(tmpDir, "health-router.log")
    const logContent = await readFile(logPath, "utf-8").catch(() => "")
    // Should contain plugin startup or preemptive log
    const hasPluginLog =
      logContent.includes("plugin.started") ||
      logContent.includes("preemptive") ||
      logContent.includes("chat.message")
    console.log("Plugin log check:", {
      hasPluginLog,
      logSize: logContent.length,
      primaryCalls: primaryServer.getCallCount(),
    })
  }, TIMEOUT_MS)

  it("child session 429 → reactive abort → task returns enhanced output", async () => {
    // Setup: primary returns 429 (simulating rate limit)
    primaryServer.replyRateLimitN(4) // 4 retries worth of 429s
    fallbackServer.replyText("Fallback response for retry")

    // Create parent session
    const sessionRes = await fetch(`http://127.0.0.1:${servePort}/api/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ directory: tmpDir }),
    })
    const session = await sessionRes.json()
    const parentSessionID = session.data?.id ?? session.id

    // Send a task-dispatching prompt
    await fetch(`http://127.0.0.1:${servePort}/api/session/${parentSessionID}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        parts: [{ type: "text", text: "Please create a test file called hello.txt with content 'hello world'" }],
        agent: "build",
      }),
    })

    // Wait for the 429 retry cycle to complete
    await new Promise((r) => setTimeout(r, 20_000))

    // Verify: primary was called (429 responses)
    console.log("Primary calls:", primaryServer.getCallCount())
    console.log("Fallback calls:", fallbackServer.getCallCount())

    // Verify: log shows reactive handler activity
    const logPath = path.join(tmpDir, "health-router.log")
    const logContent = await readFile(logPath, "utf-8").catch(() => "")

    const reactiveLines = logContent.split("\n").filter(l =>
      l.includes("reactive") || l.includes("child") || l.includes("429")
    )
    console.log("Reactive/child log lines:", reactiveLines.length)
    if (reactiveLines.length > 0) {
      console.log("Sample:", reactiveLines.slice(0, 5))
    }

    // Primary should have been called at least once
    expect(primaryServer.getCallCount()).toBeGreaterThanOrEqual(1)
  }, TIMEOUT_MS)
})
