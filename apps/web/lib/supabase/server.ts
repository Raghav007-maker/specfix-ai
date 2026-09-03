import 'server-only';
import { cookies } from 'next/headers';
import { createServerClient, type CookieOptions } from '@supabase/ssr';

type CookieToSet = { name: string; value: string; options: CookieOptions };

/**
 * The Supabase client for server components, server actions, and route handlers.
 *
 * It is used for identity only — sign-in, sign-out, and reading the current user.
 * All tenant data goes through @specfix/db (see lib/repos.ts), never through this
 * client, so that tenant isolation stays a property of the repository layer.
 *
 * `cookies()` is async in Next 15, so this factory is async too.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: CookieToSet[]) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // `set` throws when called from a Server Component (cookies are already
            // sent). That is fine: the middleware refreshes the session cookie on
            // every request, so the write here is only an optimization.
          }
        },
      },
    }
  );
}
