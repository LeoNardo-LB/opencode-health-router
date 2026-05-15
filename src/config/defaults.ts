import type { ClassificationRule, Config } from "../types.js"

// ─── 所有默认值的单一来源 (Single Source of Truth) ───
// generator.ts 的模板也会引用这些常量，避免 defaults 与模板不一致

export const DEFAULT_ENABLED = true

export const DEFAULT_FAILURE_PENALTY = 20
export const DEFAULT_PRIMARY_RECOVERY_INTERVAL_MS = 600_000  // 10 min
export const DEFAULT_PRIMARY_RECOVERY_BONUS = 20             // +20 per tick
export const DEFAULT_PRIMARY_SUCCESS_BEHAVIOR = "full" as const
export const DEFAULT_FALLBACK_RECOVERY_INTERVAL_MS = 1_800_000
export const DEFAULT_FALLBACK_RECOVERY_BONUS = 5
export const DEFAULT_FALLBACK_SUCCESS_BONUS = 5

export const DEFAULT_MAX_RETRIES = 3
export const DEFAULT_RETRY_WINDOW_MS = 60_000  // 60 seconds

export const DEFAULT_LOG_LEVEL = "warn"

export const DEFAULT_CLASSIFICATION_RULES: ClassificationRule[] = [
  // 内置规则（状态码映射 + 通用 pattern）始终生效，见 classifier.ts BUILTIN_RULES
  // 此处仅用于配置 schema 的 default 值，实际为空即可
]

export const DEFAULT_CONFIG: Config = {
  enabled: DEFAULT_ENABLED,
  classification: { rules: DEFAULT_CLASSIFICATION_RULES },
  healthScore: {
    failurePenalty: DEFAULT_FAILURE_PENALTY,
    primary: {
      recoveryIntervalMs: DEFAULT_PRIMARY_RECOVERY_INTERVAL_MS,
      recoveryBonus: DEFAULT_PRIMARY_RECOVERY_BONUS,
      successBehavior: DEFAULT_PRIMARY_SUCCESS_BEHAVIOR,
    },
    fallback: {
      recoveryIntervalMs: DEFAULT_FALLBACK_RECOVERY_INTERVAL_MS,
      recoveryBonus: DEFAULT_FALLBACK_RECOVERY_BONUS,
      successBonus: DEFAULT_FALLBACK_SUCCESS_BONUS,
    },
  },
  retryPolicy: { maxRetries: DEFAULT_MAX_RETRIES, retryWindowMs: DEFAULT_RETRY_WINDOW_MS },
  agents: { "*": { fallbackModels: [] } },
  primaryModels: new Set(),
  agentModels: {},
  logging: { level: DEFAULT_LOG_LEVEL, path: "" },
}
