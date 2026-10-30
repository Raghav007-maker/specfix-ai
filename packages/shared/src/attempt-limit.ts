/**
 * A fixed-window attempt counter, kept in memory. Used to cap sign-in and sign-up attempts
 * per client IP and per email so one caller cannot brute-force a password or use up the
 * Auth server's rate limit, which it applies to our server's IP and so to every user at once.
 *
 * The map is bounded: once `maxKeys` keys are held, the oldest is dropped, so a flood of
 * distinct keys cannot grow memory without limit.
 */
export class AttemptLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly maxKeys = 10_000
  ) {}

  /** Counts one attempt for `key`; false once the key has used up its window. */
  take(key: string, now = Date.now()): boolean {
    let hit = this.hits.get(key);
    if (!hit || hit.resetAt <= now) {
      this.hits.delete(key);
      if (this.hits.size >= this.maxKeys) this.hits.delete(this.hits.keys().next().value!);
      hit = { count: 0, resetAt: now + this.windowMs };
      this.hits.set(key, hit);
    }
    hit.count++;
    return hit.count <= this.max;
  }
}
