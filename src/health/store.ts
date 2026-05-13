import type { HealthEntry, ModelKey } from "../types.js"
import type { Config } from "../types.js"

export class HealthStore {
  private store = new Map<ModelKey, HealthEntry>()
  private config: Config

  constructor(config: Config) {
    this.config = config
  }

  get(key: ModelKey): number {
    return this.store.get(key)?.score ?? 100
  }

  isPrimary(key: ModelKey): boolean {
    return this.config.primaryModels.has(key)
  }

  recordFailure(key: ModelKey): void {
    const existing = this.store.get(key)
    const score = Math.max(0, (existing?.score ?? 100) - this.config.healthScore.failurePenalty)
    this.store.set(key, { score, lastRecoveryAt: Date.now() })
  }

  recordSuccess(key: ModelKey): void {
    const isPrimary = this.isPrimary(key)
    if (isPrimary) {
      this.store.set(key, { score: 100, lastRecoveryAt: 0 })
    } else {
      const existing = this.store.get(key)
      const score = Math.min(100, (existing?.score ?? 100) + this.config.healthScore.fallback.successBonus)
      this.store.set(key, {
        score,
        lastRecoveryAt: score >= 100 ? 0 : (existing?.lastRecoveryAt ?? Date.now()),
      })
    }
  }

  tick(): void {
    const now = Date.now()
    for (const [key, entry] of this.store) {
      if (entry.lastRecoveryAt <= 0) continue
      const isPrimary = this.isPrimary(key)
      const { recoveryIntervalMs, recoveryBonus } = isPrimary
        ? this.config.healthScore.primary
        : this.config.healthScore.fallback

      if (now - entry.lastRecoveryAt >= recoveryIntervalMs) {
        const newScore = Math.min(100, entry.score + recoveryBonus)
        this.store.set(key, {
          score: newScore,
          lastRecoveryAt: newScore >= 100 ? 0 : now,
        })
      }
    }
  }

  sort(models: ModelKey[]): ModelKey[] {
    return [...models].sort((a, b) => {
      const scoreDiff = this.get(b) - this.get(a)
      if (scoreDiff !== 0) return scoreDiff
      return models.indexOf(a) - models.indexOf(b)
    })
  }

  /** For testing */
  _set(key: ModelKey, entry: HealthEntry): void {
    this.store.set(key, entry)
  }

  _size(): number {
    return this.store.size
  }
}
