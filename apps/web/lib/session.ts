import 'server-only';
import { redirect } from 'next/navigation';
import type { User } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';

/** The authenticated user, or null. Its `id` is the auth.users UUID the repositories
 * use as user_id / reviewer_id — no separate mapping table is needed. */
export async function getUser(): Promise<User | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user ?? null;
}

/** As getUser, but sends anonymous visitors to the login page. */
export async function requireUser(): Promise<User> {
  const user = await getUser();
  if (!user) redirect('/login');
  return user;
}
