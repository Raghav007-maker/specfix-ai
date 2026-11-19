import 'server-only';
import { cache } from 'react';
import { redirect } from 'next/navigation';
import type { User } from '@supabase/supabase-js';
import { needsSecondFactor, recoveryIsFresh } from '@specfix/shared';
import { createClient } from '@/lib/supabase/server';

const USER_TTL_MS = 60_000;
const recentUsers = new Map<string, { user: User; at: number }>();

/**
 * The signed-in user and whether the session still owes its second step (an authenticator
 * code), or null when nobody is signed in.
 *
 * Who is signed in comes from getClaims(), which verifies the session token's signature and
 * expiry locally (ES256, cached public key). The full user record (email confirmation,
 * profile metadata, MFA factors) still comes from the Auth server via getUser(), but at most
 * once a minute per user: that round trip was ~230 ms on every page. The cache is keyed by the
 * verified `sub`, so it can never hand one user another's record; a profile or email change
 * shows up within a minute (forgetUser makes a factor change apply at once).
 *
 * The factors come from that server record, never from the session cookie's copy of the user,
 * which the browser could edit to hide a factor.
 */
export const getSession = cache(async (): Promise<{ user: User; pending: boolean } | null> => {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const sub = data?.claims.sub;
  if (!sub) return null;

  let hit = recentUsers.get(sub);
  if (!hit || Date.now() - hit.at >= USER_TTL_MS) {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user || user.id !== sub) return null;
    // shortcut: per-process map, cleared wholesale at 1000 users; fine for one server.
    if (recentUsers.size >= 1000) recentUsers.clear();
    hit = { user, at: Date.now() };
    recentUsers.set(sub, hit);
  }
  return { user: hit.user, pending: needsSecondFactor(data.claims.aal, hit.user.factors) };
});

/** Drops a user's cached record, so a factor just added or removed applies on the next request. */
export function forgetUser(userId: string): void {
  recentUsers.delete(userId);
}

/** The authenticated user, or null. Its `id` is the auth.users UUID the repositories
 * use as user_id / reviewer_id — no separate mapping table is needed.
 *
 * A user with two-step verification on who has not entered their code yet is sent to
 * /login/verify, so no page or action runs for a half-signed-in session.
 *
 * Wrapped in React `cache()` so several server components in one render share one call. */
export const getUser = cache(async (): Promise<User | null> => {
  const session = await getSession();
  if (!session) return null;
  if (session.pending) redirect('/login/verify');
  return session.user;
});

/** As getUser, but sends anonymous visitors to the landing page (or `signedOutTo`). */
export async function requireUser(signedOutTo: '/' | '/login' = '/'): Promise<User> {
  const user = await getUser();
  // Pages send a signed-out visitor to the landing page; OAuth routes go straight to sign-in.
  if (!user) redirect(signedOutTo);
  return user;
}

/**
 * The signed-in user, only when this session came from a password-reset link opened in the last
 * 15 minutes (the verified token's `amr` claim). Anything else gets null, so the new-password
 * form never works for a session that simply signed in with a password.
 */
export async function getRecoveryUser(): Promise<User | null> {
  const session = await getSession();
  if (!session) return null;
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;
  if (!claims || claims.sub !== session.user.id) return null;
  return recoveryIsFresh(claims.amr, Math.floor(Date.now() / 1000)) ? session.user : null;
}
