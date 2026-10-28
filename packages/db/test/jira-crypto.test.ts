/**
 * Token encryption at rest. Pure crypto — no database needed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { TokenKeyError, decryptSecret, encryptSecret, tokenKeyId } from '../src/crypto.ts';

const saved = process.env.TOKEN_ENCRYPTION_KEY;

beforeEach(() => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString('base64');
});

afterEach(() => {
  if (saved === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
  else process.env.TOKEN_ENCRYPTION_KEY = saved;
});

describe('token encryption', () => {
  it('round-trips under the same context', () => {
    const sealed = encryptSecret('secret-token', 'jira:t1:read:access');
    expect(sealed.toString('utf8')).not.toContain('secret-token');
    expect(decryptSecret(sealed, 'jira:t1:read:access', tokenKeyId())).toBe('secret-token');
  });

  it('uses a fresh IV every time', () => {
    const a = encryptSecret('same', 'ctx');
    const b = encryptSecret('same', 'ctx');
    expect(a.equals(b)).toBe(false);
  });

  it('refuses a ciphertext moved to another tenant or grant', () => {
    const sealed = encryptSecret('secret-token', 'jira:t1:read:access');
    expect(() => decryptSecret(sealed, 'jira:t2:read:access', tokenKeyId())).toThrow();
    expect(() => decryptSecret(sealed, 'jira:t1:write:access', tokenKeyId())).toThrow();
  });

  it('refuses a tampered ciphertext', () => {
    const sealed = encryptSecret('secret-token', 'ctx');
    sealed[sealed.length - 1]! ^= 0xff;
    expect(() => decryptSecret(sealed, 'ctx', tokenKeyId())).toThrow();
  });

  it('reports a changed key as a key change, not as tampering', () => {
    const sealed = encryptSecret('secret-token', 'ctx');
    const oldKeyId = tokenKeyId();
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    expect(() => decryptSecret(sealed, 'ctx', oldKeyId)).toThrow(/different TOKEN_ENCRYPTION_KEY/);
  });

  it('rejects a missing or wrong-length key', () => {
    delete process.env.TOKEN_ENCRYPTION_KEY;
    expect(() => encryptSecret('x', 'ctx')).toThrow(TokenKeyError);
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(16).toString('base64');
    expect(() => encryptSecret('x', 'ctx')).toThrow(/32 random bytes/);
  });
});
