import 'server-only';
import { cache } from 'react';
import { redirect } from 'next/navigation';
import type { User } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';

const USER_TTL_MS = 60_000;
const recentUsers = new Map<string, { user: User; at: number }>();

/** The authenticated user, or null. Its `id` is the auth.users UUID the repositories
 * use as user_id / reviewer_id — no separate mapping table is needed.
 *
 * Who is signed in comes from getClaims(), which verifies the session token's signature and
 * expiry locally (ES256, cached public key). The full user record (email confirmation,
 * profile metadata) still comes from the Auth server via getUser(), but at most once a
 * minute per user: that round trip was ~230 ms on every page. The cache is keyed by the
 * verified `sub`, so it can never hand one user another's record; a profile or email change
 * shows up within a minute.
 *
 * Wrapped in React `cache()` so several server components in one render share one call. */
export const getUser = cache(async (): Promise<User | null> => {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const sub = data?.claims.sub;
  if (!sub) return null;

  const hit = recentUsers.get(sub);
  if (hit && Date.now() - hit.at < USER_TTL_MS) return hit.user;

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || user.id !== sub) return null;
  // shortcut: per-process map, cleared wholesale at 1000 users; fine for one server.
  if (recentUsers.size >= 1000) recentUsers.clear();
  recentUsers.set(sub, { user, at: Date.now() });
  return user;
});

/** As getUser, but sends anonymous visitors to the login page. */
export async function requireUser(): Promise<User> {
  const user = await getUser();
  if (!user) redirect('/login');
  return user;
}
