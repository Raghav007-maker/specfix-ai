/**
 * Settings the worker reads from its environment.
 */

/**
 * This app's public HTTPS origin (PUBLIC_BASE_URL), for links SpecFix posts to GitHub. Null
 * for anything else, including plain http on localhost: a link GitHub shows must be reachable.
 */
export function publicBaseUrlFromEnv(
  env: Record<string, string | undefined> = process.env
): string | null {
  const raw = env.PUBLIC_BASE_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}
