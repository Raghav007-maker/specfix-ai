import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createState, verifyState } from '../src/index.ts';

describe('OAuth state', () => {
  const key = randomBytes(32);
  const now = 1_800_000_000_000;

  it('round-trips the tenant and user it was made for', () => {
    const token = createState({ tenantId: 't1', userId: 'u1' }, key, now);
    expect(verifyState(token, key, now + 1000)).toMatchObject({ tenantId: 't1', userId: 'u1' });
  });

  it('refuses an expired, re-signed, edited or malformed state', () => {
    const token = createState({ tenantId: 't1', userId: 'u1' }, key, now);
    expect(verifyState(token, key, now + 11 * 60_000)).toBeNull();
    expect(verifyState(token, randomBytes(32), now)).toBeNull();
    const [payload, sig] = token.split('.');
    const edited = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(payload!, 'base64url').toString()),
        tenantId: 't2',
      })
    ).toString('base64url');
    expect(verifyState(`${edited}.${sig}`, key, now)).toBeNull();
    expect(verifyState('nope', key, now)).toBeNull();
    expect(verifyState(`${token}.extra`, key, now)).toBeNull();
  });
});
