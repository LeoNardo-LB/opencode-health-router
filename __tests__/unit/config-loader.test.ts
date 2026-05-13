import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { loadConfig } from "../../src/config/loader.js"
import { createLogger } from "../../src/logging/logger.js"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"

describe("loadConfig", () => {
  const tmpDir = path.join(os.tmpdir(), "mf-test-" + Date.now())
  const tmpConfigDir = path.join(os.tmpdir(), "mf-test-config-" + Date.now())
  const logger = createLogger({ level: "error" })

  beforeEach(() => {
    fs.mkdirSync(path.join(tmpDir, ".opencode"), { recursive: true })
    fs.mkdirSync(tmpConfigDir, { recursive: true })
  })
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    fs.rmSync(tmpConfigDir, { recursive: true, force: true })
  })

  it("returns defaults when no config file found in workdir", () => {
    const { config } = loadConfig(logger, tmpDir, tmpConfigDir)
    expect(config.enabled).toBe(true)
    expect(config.agents).toBeDefined()
  })

  it("loads valid config from .opencode/health-router.json", () => {
    const fixturePath = path.join(__dirname, "..", "..", "fixtures", "health-router-valid.json")
    const dest = path.join(tmpDir, ".opencode", "health-router.json")
    fs.copyFileSync(fixturePath, dest)

    const { config, configPath } = loadConfig(logger, tmpDir, tmpConfigDir)
    expect(configPath).toContain("health-router.json")
    expect(config.agents["build"].fallbackModels).toEqual(["deepseek/deepseek-v4-pro"])
  })

  it("disables plugin on invalid JSON", () => {
    const dest = path.join(tmpDir, ".opencode", "health-router.json")
    fs.writeFileSync(dest, "{ invalid json }")

    const { config } = loadConfig(logger, tmpDir, tmpConfigDir)
    expect(config.enabled).toBe(false)
  })
})
