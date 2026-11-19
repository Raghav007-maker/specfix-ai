/**
 * The OAuth `state` for installing the GitHub App.
 *
 * Signed with a server key and also stored in an httpOnly cookie by the caller. The callback
 * accepts a state only if it equals the cookie, verifies, and has not expired — so a consent
 * started in one browser (or by an attacker) cannot complete in another, and the tenant it
 * names cannot be edited in transit.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export interface OAuthState {
  tenantId: string;
  userId: string;
  nonce: string;
  expiresAt: number;
}

const STATE_TTL_MS = 10 * 60_000;

export function createState(
  input: { tenantId: string; userId: string },
  key: Buffer,
  now: number = Date.now()
): string {
  const state: OAuthState = {
    tenantId: input.tenantId,
    userId: input.userId,
    nonce: randomBytes(16).toString('base64url'),
    expiresAt: now + STATE_TTL_MS,
  };
  const payload = Buffer.from(JSON.stringify(state)).toString('base64url');
  return `${payload}.${sign(payload, key)}`;
}

/** The state if it is authentic and unexpired, otherwise null. */
export function verifyState(
  token: string,
  key: Buffer,
  now: number = Date.now()
): OAuthState | null {
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra !== undefined) return null;
  const expected = Buffer.from(sign(payload, key));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const state = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as OAuthState;
    if (typeof state.expiresAt !== 'number' || state.expiresAt < now) return null;
    if (typeof state.tenantId !== 'string' || typeof state.userId !== 'string') return null;
    return state;
  } catch {
    return null;
  }
}

function sign(payload: string, key: Buffer): string {
  return createHmac('sha256', key).update(payload).digest('base64url');
}
