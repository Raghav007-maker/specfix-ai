/**
 * A profile photo URL from a user's account metadata, or null. The metadata is set by the user
 * themselves, so only https photos from the hosts sign-in actually uses are shown: our own
 * Supabase storage (`ownHost`, for uploaded avatars), Google and GitHub. Anything else could be
 * a tracking pixel that logs teammates' IP addresses when they open the Team page.
 */
export function safeAvatarUrl(
  raw: string | null | undefined,
  ownHost: string | null
): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  const host = url.host.toLowerCase();
  const allowed =
    (ownHost !== null && host === ownHost.toLowerCase()) ||
    host.endsWith('.googleusercontent.com') ||
    host === 'avatars.githubusercontent.com';
  return allowed ? url.toString() : null;
}
