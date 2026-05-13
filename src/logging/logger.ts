import type { LoggingConfig } from "../types.js"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"

export interface Logger {
  debug(event: string, data?: Record<string, unknown>): void
  info(event: string, data?: Record<string, unknown>): void
  warn(event: string, data?: Record<string, unknown>): void
  error(event: string, data?: Record<string, unknown>): void
}

const LEVELS: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 }

const MAX_LOG_SIZE = 10 * 1024 * 1024 // 10MB

export function createLogger(config: Partial<LoggingConfig> = {}): Logger {
  const level = config.level ?? "debug"
  const minLevel = LEVELS[level]
  const logPath = config.path ?? path.join(os.homedir(), ".local", "share", "opencode", "logs", "health-router.log")
  const dir = path.dirname(logPath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

  function rotateIfNeeded(filePath: string) {
    try {
      if (!fs.existsSync(filePath)) return
      const stats = fs.statSync(filePath)
      if (stats.size > MAX_LOG_SIZE) {
        const oldPath = filePath + ".old"
        if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath)
        fs.renameSync(filePath, oldPath)
      }
    } catch {
      // silently ignore rotation failures
    }
  }

  function log(severity: string, event: string, data?: Record<string, unknown>) {
    if (LEVELS[severity] < minLevel) return
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      level: severity,
      event,
      ...data,
    }) + "\n"
    try {
      rotateIfNeeded(logPath)
      fs.appendFileSync(logPath, entry, "utf-8")
    } catch {
      // silently ignore write failures
    }
  }

  return {
    debug: (e, d) => log("debug", e, d),
    info: (e, d) => log("info", e, d),
    warn: (e, d) => log("warn", e, d),
    error: (e, d) => log("error", e, d),
  }
}
