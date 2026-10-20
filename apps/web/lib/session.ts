import 'server-only';
import { cache } from 'react';
import { redirect } from 'next/navigation';
import type { User } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';

/** The authenticated user, or null. Its `id` is the auth.users UUID the repositories
 * use as user_id / reviewer_id — no separate mapping table is needed.
 *
 * Wrapped in React `cache()` so that if several server components in the same render
 * ask for the user, they share one `getUser()` round-trip to the auth server rather than
 * each issuing its own. The cache is per-request, so it never leaks one user's identity
 * into another request. (The middleware's own `getUser()` runs in a separate runtime and
 * is intentionally kept — it refreshes the session cookie — so it is not deduped here.) */
export const getUser = cache(async (): Promise<User | null> => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user ?? null;
});

/** As getUser, but sends anonymous visitors to the login page. */
export async function requireUser(): Promise<User> {
  const user = await getUser();
  if (!user) redirect('/login');
  return user;
}
