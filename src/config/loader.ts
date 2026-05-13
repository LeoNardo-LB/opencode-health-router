import type { Config, ModelKey } from "../types.js"
import type { Logger } from "../logging/logger.js"
import { validate } from "./schema.js"
import * as fs from "fs"
import * as path from "path"
import { parseJSONC } from "../jsonc.js"

export interface LoadResult {
  config: Config
  configPath: string | null
  warnings: string[]
}

function deepMerge(base: unknown, override: unknown): unknown {
  if (Array.isArray(override)) return override
  if (Array.isArray(base)) return override
  if (
    base !== null && typeof base === "object" &&
    override !== null && typeof override === "object" &&
    !Array.isArray(base) && !Array.isArray(override)
  ) {
    const result = { ...base }
    for (const key of Object.keys(override as Record<string, unknown>)) {
      ;(result as Record<string, unknown>)[key] = deepMerge(
        (base as Record<string, unknown>)[key],
        (override as Record<string, unknown>)[key],
      )
    }
    return result
  }
  return override
}

function loadConfigFile(filePath: string, logger: Logger): unknown | null {
  try {
    const content = fs.readFileSync(filePath, "utf-8")
    return filePath.endsWith(".jsonc") ? parseJSONC(content) : JSON.parse(content)
  } catch {
    logger.error("config.parse_error", { path: filePath })
    return undefined
  }
}

export function loadConfig(logger: Logger, workdir: string | undefined, configDir: string): LoadResult {
  const searchDirs = [workdir, configDir].filter(Boolean) as string[]

  // Directory groups in priority order: .opencode/ > opencode/ > root
  const subdirs = [".opencode", "opencode", ""]

  let configPath: string | null = null
  let raw: unknown = {}

  for (const dir of searchDirs) {
    for (const subdir of subdirs) {
      const baseDir = subdir ? path.join(dir, subdir) : dir
      const jsonPath = path.join(baseDir, "health-router.json")
      const jsoncPath = path.join(baseDir, "health-router.jsonc")

      let base: unknown = null
      let baseParsed = true

      if (fs.existsSync(jsonPath)) {
        const result = loadConfigFile(jsonPath, logger)
        if (result === undefined) {
          const disabled = { ...validate({}).config, enabled: false }
          return { config: disabled, configPath: jsonPath, warnings: ["Config parse error; plugin disabled"] }
        }
        base = result
      }

      if (fs.existsSync(jsoncPath)) {
        const result = loadConfigFile(jsoncPath, logger)
        if (result === undefined) {
          const disabled = { ...validate({}).config, enabled: false }
          return { config: disabled, configPath: jsoncPath, warnings: ["Config parse error; plugin disabled"] }
        }
        raw = base !== null ? deepMerge(base, result) : result
        configPath = jsoncPath
      } else if (base !== null) {
        raw = base
        configPath = jsonPath
      }

      if (configPath) break
    }
    if (configPath) break
  }

  if (!configPath) {
    logger.warn("config.not_found", { searched: searchDirs })
  } else {
    logger.info("config.loaded", { path: configPath })
  }

  const { config, warnings } = validate(raw)

  // Search opencode config: try .jsonc first (with comments), then .json
  const opencodePaths = [
    path.join(configDir, "opencode", "opencode.jsonc"),
    path.join(configDir, "opencode", "opencode.json"),
  ]
  let opencodePath: string | null = null
  for (const p of opencodePaths) {
    if (fs.existsSync(p)) {
      opencodePath = p
      break
    }
  }

  if (opencodePath) {
    try {
      const opencodeRaw = fs.readFileSync(opencodePath, "utf-8")
      const opencodeConfig = parseJSONC(opencodeRaw)
      const primarySet = new Set<ModelKey>()
      if (opencodeConfig && typeof opencodeConfig === "object" && "agent" in opencodeConfig && typeof opencodeConfig.agent === "object" && opencodeConfig.agent !== null) {
        for (const cfg of Object.values(opencodeConfig.agent as Record<string, { model?: string }>)) {
          if (cfg?.model && typeof cfg.model === "string") primarySet.add(cfg.model)
        }
      }
      config.primaryModels = primarySet
      logger.debug("opencode.primary_models", { models: [...primarySet] })
    } catch {
      logger.error("opencode.parse_error", { path: opencodePath })
    }
  } else {
    logger.warn("opencode.not_found", { searched: opencodePaths })
  }

  return { config, configPath, warnings }
}
