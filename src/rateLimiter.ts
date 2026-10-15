/**
 * Spaces requests out so we never exceed Starling's per-second limit
 * (5 requests/second for personal access tokens).
 */
export class RateLimiter {
  private readonly intervalMs: number;
  private nextSlot = 0;
  private dailyCount = 0;
  private dayKey = RateLimiter.today();

  constructor(requestsPerSecond: number) {
    this.intervalMs = Math.ceil(1000 / requestsPerSecond);
  }

  private static today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  async acquire(): Promise<void> {
    const now = Date.now();
    const slot = Math.max(now, this.nextSlot);
    this.nextSlot = slot + this.intervalMs;
    if (slot > now) await new Promise((r) => setTimeout(r, slot - now));
    const day = RateLimiter.today();
    if (day !== this.dayKey) {
      this.dayKey = day;
      this.dailyCount = 0;
    }
    this.dailyCount++;
  }

  /** Requests made by this server process today (Starling allows 1,000/day per personal token). */
  get requestsToday(): number {
    return this.dailyCount;
  }
}
