import { createBrowserClient } from '@supabase/ssr';

/**
 * The Supabase client for the browser, sharing the session cookie the server client reads. Used
 * for the user's own identity data only (their profile photo); tenant data never goes through it.
 */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
