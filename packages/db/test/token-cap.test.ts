/**
 * In-flight token cap reservations prevent concurrent LLM calls from all passing the
 * pre-call ceiling check before any of them records its billed tokens.
 *
 * Skipped without SPECFIX_TEST_DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closePool,
  createTenant,
  isOverTokenCap,
  query,
  reservedTokensForTenant,
  tryReserveTokenCap,
} from '../src/index.ts';

const hasDatabase = Boolean(process.env.SPECFIX_TEST_DATABASE_URL);

afterAll(async () => {
  if (hasDatabase) await closePool();
});

describe.skipIf(!hasDatabase)('token cap reservation', () => {
  const label = `tokcap-${Date.now()}`;
  let tenantId: string;

  beforeAll(async () => {
    tenantId = (await createTenant(label)).id;
    await query(`update tenants set monthly_token_cap = 10000 where id = $1`, [tenantId]);
  });

  it('allows one reservation near the ceiling, blocks concurrent overflow, and restores on release', async () => {
    const first = await tryReserveTokenCap(tenantId, 6000);
    expect(first.allowed).toBe(true);
    expect(reservedTokensForTenant(tenantId)).toBe(6000);
    expect(await isOverTokenCap(tenantId)).toBe(false);

    // Next reservation fits (6000 + 4000 = 10000), reaching the cap; any third caller is blocked.
    const second = await tryReserveTokenCap(tenantId, 4000);
    expect(second.allowed).toBe(true);
    expect(await isOverTokenCap(tenantId)).toBe(true);

    const third = await tryReserveTokenCap(tenantId, 2000);
    expect(third.allowed).toBe(false);

    first.release();
    first.release(); // idempotent
    second.release();
    expect(reservedTokensForTenant(tenantId)).toBe(0);
    expect(await isOverTokenCap(tenantId)).toBe(false);
  });

  it('blocks parallel callers once reservations meet the cap', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => tryReserveTokenCap(tenantId, 5000))
    );
    const allowed = results.filter((r) => r.allowed);
    try {
      expect(allowed).toHaveLength(2);
      expect(reservedTokensForTenant(tenantId)).toBe(10000);
    } finally {
      for (const r of results) r.release();
    }
    expect(reservedTokensForTenant(tenantId)).toBe(0);
  });
});
