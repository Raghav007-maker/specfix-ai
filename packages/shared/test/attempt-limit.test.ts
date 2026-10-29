import { describe, expect, it } from 'vitest';
import { AttemptLimiter } from '../src/index.ts';

describe('AttemptLimiter', () => {
  it('allows `max` attempts per window, then refuses until the window ends', () => {
    const limit = new AttemptLimiter(3, 1000);
    expect([1, 2, 3, 4].map(() => limit.take('ip', 0))).toEqual([true, true, true, false]);
    expect(limit.take('ip', 999)).toBe(false);
    expect(limit.take('ip', 1000)).toBe(true);
  });

  it('counts each key on its own', () => {
    const limit = new AttemptLimiter(1, 1000);
    expect(limit.take('a', 0)).toBe(true);
    expect(limit.take('a', 0)).toBe(false);
    expect(limit.take('b', 0)).toBe(true);
  });

  it('keeps at most maxKeys keys, so a flood of new keys cannot grow memory', () => {
    const limit = new AttemptLimiter(1, 1000, 2);
    limit.take('a', 0);
    limit.take('b', 0);
    limit.take('c', 0); // drops 'a', the oldest
    expect(limit.take('a', 0)).toBe(true);
    expect(limit.take('c', 0)).toBe(false);
  });

  it('lets exactly `max` of many parallel attempts through', async () => {
    const limit = new AttemptLimiter(10, 60_000);
    const results = await Promise.all(
      Array.from({ length: 200 }, async () => limit.take('same-email@example.com'))
    );
    expect(results.filter(Boolean)).toHaveLength(10);
  });
});
