import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { generateTemplate } from "../../src/config/generator.js"
import type { Logger } from "../../src/logging/logger.js"

function makeLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
}

describe("generateTemplate", () => {
  let tmpDir: string
  let logger: Logger

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mf-test-"))
    logger = makeLogger()
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("generates default template when no opencode config provided", () => {
    const result = generateTemplate(logger, undefined, tmpDir)
    expect(result).not.toBeNull()
    const content = fs.readFileSync(result!, "utf-8")
    expect(content).toContain('"build"')
    expect(content).toContain('"enabled"')
    expect(content).toContain('"healthScore"')
    expect(content).toContain('"agents"')
  })

  it("extracts agent names from opencode config", () => {
    const opencodeConfig = {
      agent: {
        coder: { model: "zhipuai/glm-5.1" },
        reviewer: { model: "deepseek/v4-pro" },
        hidden_agent: { hidden: true },
      },
    }
    const result = generateTemplate(logger, opencodeConfig, tmpDir)
    expect(result).not.toBeNull()
    const content = fs.readFileSync(result!, "utf-8")
    expect(content).toContain('"coder"')
    expect(content).toContain('"reviewer"')
    expect(content).not.toContain('"hidden_agent"')
  })

  it("returns null when config file already exists", () => {
    const result1 = generateTemplate(logger, undefined, tmpDir)
    expect(result1).not.toBeNull()
    const result2 = generateTemplate(logger, undefined, tmpDir)
    expect(result2).toBeNull()
  })

  it("returns null and logs error on write failure", () => {
    const result = generateTemplate(logger, undefined, "/dev/null/impossible")
    expect(result).toBeNull()
    expect(logger.error).toHaveBeenCalled()
  })
})
