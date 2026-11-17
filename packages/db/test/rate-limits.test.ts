/**
 * The shared rate limiter: exactly `max` attempts per window even under parallel requests,
 * separate buckets and values, a fresh window after it expires, and no raw IP or email in
 * the table.
 *
 * Skipped without SPECFIX_TEST_DATABASE_URL.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { RateLimiter, closePool, query } from '../src/index.ts';

const hasDatabase = Boolean(process.env.SPECFIX_TEST_DATABASE_URL);

afterAll(async () => {
  if (hasDatabase) await closePool();
});

describe.skipIf(!hasDatabase)('shared rate limits', () => {
  const run = `${Date.now()}`;

  it('allows exactly max attempts when 20 arrive at once', async () => {
    const limiter = new RateLimiter(`burst-${run}`, 5, 60_000);
    const results = await Promise.all(Array.from({ length: 20 }, () => limiter.take('10.0.0.1')));
    expect(results.filter(Boolean)).toHaveLength(5);
  });

  it('counts each bucket and value on its own', async () => {
    const a = new RateLimiter(`a-${run}`, 1, 60_000);
    const b = new RateLimiter(`b-${run}`, 1, 60_000);
    expect(await a.take('x')).toBe(true);
    expect(await a.take('x')).toBe(false);
    expect(await a.take('y')).toBe(true);
    expect(await b.take('x')).toBe(true);
  });

  it('starts a new window once the old one has passed', async () => {
    const limiter = new RateLimiter(`window-${run}`, 1, 200);
    expect(await limiter.take('u')).toBe(true);
    expect(await limiter.take('u')).toBe(false);
    await new Promise((r) => setTimeout(r, 300));
    expect(await limiter.take('u')).toBe(true);
  });

  it('stores only hashes, never the raw email or IP', async () => {
    const email = `secret-${run}@example.test`;
    await new RateLimiter(`pii-${run}`, 5, 60_000).take(email);
    const leaked = await query<{ n: number }>(
      `select count(*)::int as n from rate_limits where key like $1`,
      [`%${run}%`]
    );
    expect(leaked[0]!.n).toBe(0);
    const bad = await query<{ n: number }>(
      `select count(*)::int as n from rate_limits where key !~ '^[0-9a-f]{64}$'`,
      []
    );
    expect(bad[0]!.n).toBe(0);
  });
});
