import type { ModelKey } from "../types.js"

interface CounterEntry {
  count: number
  firstSeenAt: number
}

/**
 * Per-model retry counter with time-window expiry.
 *
 * In OpenCode serve mode, each retry creates a new session with attempt=1.
 * This counter tracks consecutive failures per model within a sliding window,
 * replacing the broken attempt-based gate with a plugin-side equivalent.
 *
 * Lifecycle:
 *   - increment() called on each classified retry event
 *   - reset() called on: successful model response, successful fallback switch, tick cleanup
 *   - cleanup() called from tick timer every 30s
 */
export class RetryCounter {
  private counts = new Map<ModelKey, CounterEntry>()
  private windowMs: number

  constructor(windowMs: number = 60_000) {
    this.windowMs = windowMs
  }

  /**
   * Increment the retry count for a model.
   * If the time window has expired since firstSeenAt, resets to 1.
   * Returns the current count after incrementing.
   */
  increment(modelKey: ModelKey): number {
    const now = Date.now()
    const entry = this.counts.get(modelKey)

    if (!entry || now - entry.firstSeenAt > this.windowMs) {
      // First failure or window expired → start fresh
      this.counts.set(modelKey, { count: 1, firstSeenAt: now })
      return 1
    }

    entry.count++
    return entry.count
  }

  /**
   * Get current count without modifying it.
   * Returns 0 if model has no entry or window expired.
   */
  getCount(modelKey: ModelKey): number {
    const entry = this.counts.get(modelKey)
    if (!entry) return 0
    if (Date.now() - entry.firstSeenAt > this.windowMs) {
      this.counts.delete(modelKey)
      return 0
    }
    return entry.count
  }

  /**
   * Reset the counter for a specific model.
   * Called when: model succeeds, fallback switch succeeds.
   */
  reset(modelKey: ModelKey): void {
    this.counts.delete(modelKey)
  }

  /**
   * Periodic cleanup: remove entries older than 2x windowMs.
   * Called from tick timer to prevent memory leaks.
   */
  cleanup(): void {
    const now = Date.now()
    const staleThreshold = this.windowMs * 2
    for (const [key, entry] of this.counts) {
      if (now - entry.firstSeenAt > staleThreshold) {
        this.counts.delete(key)
      }
    }
  }
}
