// ─── ModelKey ───
export type ModelKey = string // "providerID/modelID"

export function splitModelKey(key: ModelKey): { providerID: string; modelID: string } {
  const idx = key.lastIndexOf("/")
  if (idx === -1) throw new Error(`Invalid ModelKey: ${key}`)
  return {
    providerID: key.slice(0, idx),
    modelID: key.slice(idx + 1),
  }
}

// ─── Classification ───
export interface ClassificationRule {
  statusCodes: number[]
  patterns: string[]
  /** 显式指定分类（rate_limit / quota_exceeded / 5xx / timeout ...） */
  category?: string
}

export interface Classification {
  category: string
  rule: ClassificationRule
}

// ─── Config ───
export interface HealthScoreConfig {
  failurePenalty: number
  primary: {
    recoveryIntervalMs: number
    recoveryBonus: number
    successBehavior: "full"
  }
  fallback: {
    recoveryIntervalMs: number
    recoveryBonus: number
    successBonus: number
  }
}

export interface RetryPolicyConfig {
  maxRetries: number
}

export interface AgentChainConfig {
  fallbackModels: ModelKey[]
}

export interface LoggingConfig {
  level: "debug" | "info" | "warn" | "error"
  path: string
}

export interface Config {
  enabled: boolean
  classification: {
    rules: ClassificationRule[]
  }
  healthScore: HealthScoreConfig
  retryPolicy: RetryPolicyConfig
  agents: Record<string, AgentChainConfig>
  primaryModels: Set<ModelKey>
  /** agent name → default model key (extracted from opencode.jsonc agent configs) */
  agentModels: Record<string, ModelKey>
  logging: LoggingConfig
}

// ─── Health ───
export interface HealthEntry {
  score: number
  lastRecoveryAt: number
}

// ─── API Error (extracted from session.status retry) ───
export interface RetryEvent {
  type: "retry"
  attempt: number
  message: string
  next?: number
}
