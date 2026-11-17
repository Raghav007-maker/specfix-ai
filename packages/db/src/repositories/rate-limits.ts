/**
 * Fixed-window rate limits kept in Postgres, so every app server shares one count and a
 * restart does not reset it. Keys are hashed before they are stored: no raw IP or email ever
 * lands in the table.
 *
 * If the database cannot be reached (or migration 0025 is missing), the limiter falls back
 * to an in-memory window for this server, so a database outage never removes the limit.
 */
import { createHash } from 'node:crypto';
import { AttemptLimiter } from '@specfix/shared';
import { query } from '../client.ts';

export class RateLimiter {
  private readonly fallback: AttemptLimiter;

  constructor(
    private readonly bucket: string,
    private readonly max: number,
    private readonly windowMs: number
  ) {
    this.fallback = new AttemptLimiter(max, windowMs);
  }

  /** Counts one attempt for `value`; false once it has used up its window. */
  async take(value: string): Promise<boolean> {
    const key = createHash('sha256').update(`${this.bucket}:${value}`).digest('hex');
    try {
      const [row] = await query<{ hits: number }>(
        `insert into rate_limits as r (key, window_start, hits) values ($1, now(), 1)
         on conflict (key) do update set
           hits = case when r.window_start <= now() - make_interval(secs => $2)
                       then 1 else r.hits + 1 end,
           window_start = case when r.window_start <= now() - make_interval(secs => $2)
                               then now() else r.window_start end
         returning hits`,
        [key, this.windowMs / 1000]
      );
      // Old windows are only ever overwritten; sweep them now and then so the table stays small.
      if (Math.random() < 0.01) {
        await query(`delete from rate_limits where window_start < now() - interval '1 day'`, []);
      }
      return (row?.hits ?? 1) <= this.max;
    } catch (error) {
      console.warn(
        '[rate-limit] database unavailable, using this server only:',
        error instanceof Error ? error.message : error
      );
      return this.fallback.take(key);
    }
  }
}
