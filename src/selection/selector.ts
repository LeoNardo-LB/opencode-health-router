import type { Config, ModelKey } from "../types.js"
import type { HealthStore } from "../health/store.js"

export class ModelSelector {
  private config: Config
  private health: HealthStore

  constructor(config: Config, health: HealthStore) {
    this.config = config
    this.health = health
  }

  resolve(agentName: string, options?: { excludeProvider?: string }): ModelKey | null {
    const agentConfig = this.config.agents[agentName] ?? this.config.agents["*"]
    if (!agentConfig || agentConfig.fallbackModels.length === 0) return null

    let chain = agentConfig.fallbackModels
    if (options?.excludeProvider) {
      chain = chain.filter(key => !key.startsWith(options.excludeProvider! + "/"))
    }

    const sorted = this.health.sort(chain)
    return sorted[0] ?? null
  }
}
