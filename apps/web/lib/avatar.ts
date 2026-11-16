import { safeAvatarUrl as check } from '@specfix/shared';

/** A user's photo URL if it is from a trusted host (see @specfix/shared), else null. */
export function safeAvatarUrl(raw: string | null | undefined): string | null {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  return check(raw, base ? new URL(base).host : null);
}

/** "Udit Bhatt" or "udit@x.com" → "UB" / "UX": up to two initials for an avatar. */
export function initialsOf(nameOrEmail: string | null | undefined): string {
  return (
    (nameOrEmail ?? '')
      .split(/[\s@.]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join('') || '?'
  );
}
