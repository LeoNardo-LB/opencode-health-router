export function shouldIntervene(attempt: number, maxRetries: number): boolean {
  return attempt > maxRetries
}
