import { z } from "zod"
import type { Config } from "../types.js"
import {
  DEFAULT_CONFIG,
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

const classificationRuleSchema = z.object({
  statusCodes: z.array(z.number().int().min(100).max(599)).default([]),
  patterns: z.array(z.string()).default([]),
  category: z.string().optional(),
})

const healthScoreSchema = z.object({
  failurePenalty: z.number().int().min(1).max(100).default(DEFAULT_FAILURE_PENALTY),
  primary: z.object({
    recoveryIntervalMs: z.number().int().min(10_000).default(DEFAULT_PRIMARY_RECOVERY_INTERVAL_MS),
    recoveryBonus: z.number().int().min(1).max(100).default(DEFAULT_PRIMARY_RECOVERY_BONUS),
    successBehavior: z.literal("full").default(DEFAULT_PRIMARY_SUCCESS_BEHAVIOR),
  }).default({}),
  fallback: z.object({
    recoveryIntervalMs: z.number().int().min(10_000).default(DEFAULT_FALLBACK_RECOVERY_INTERVAL_MS),
    recoveryBonus: z.number().int().min(1).max(100).default(DEFAULT_FALLBACK_RECOVERY_BONUS),
    successBonus: z.number().int().min(1).max(100).default(DEFAULT_FALLBACK_SUCCESS_BONUS),
  }).default({}),
}).default({})

const retryPolicySchema = z.object({
  maxRetries: z.number().int().min(1).max(20).default(DEFAULT_MAX_RETRIES),
}).default({})

const agentChainSchema = z.object({
  fallbackModels: z.array(z.string().min(1)).default([]),
})

export const pluginConfigSchema = z.object({
  enabled: z.boolean().default(true),
  classification: z.object({
    rules: z.array(classificationRuleSchema).default(DEFAULT_CONFIG.classification.rules),
  }).default({}),
  healthScore: healthScoreSchema,
  retryPolicy: retryPolicySchema,
  agents: z.record(z.string(), agentChainSchema).default({ "*": { fallbackModels: [] } }),
  logging: z.object({
    level: z.enum(["debug", "info", "warn", "error"]).default(DEFAULT_LOG_LEVEL),
    path: z.string().default(""),
  }).default({}),
})

export function validate(raw: unknown): { config: Config; warnings: string[] } {
  const result = pluginConfigSchema.safeParse(raw)
  const warnings: string[] = []

  if (!result.success) {
    for (const issue of result.error.issues) {
      warnings.push(`${issue.path.join(".")}: ${issue.message}`)
    }
  }

  const parsed = result.success ? result.data : pluginConfigSchema.parse({})

  const config: Config = {
    enabled: parsed.enabled,
    classification: { rules: parsed.classification.rules },
    healthScore: {
      failurePenalty: parsed.healthScore.failurePenalty,
      primary: parsed.healthScore.primary,
      fallback: parsed.healthScore.fallback,
    },
    retryPolicy: parsed.retryPolicy,
    agents: parsed.agents,
    primaryModels: new Set(),
    agentModels: {},
    logging: parsed.logging,
  }

  return { config, warnings }
}
