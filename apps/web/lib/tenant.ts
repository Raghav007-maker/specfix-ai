import 'server-only';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { listMembershipsForUser, type MembershipRow } from '@/lib/repos';

const TENANT_COOKIE = 'specfix_tenant';

export type { MembershipRow };

export async function currentMemberships(userId: string): Promise<MembershipRow[]> {
  return listMembershipsForUser(userId);
}

/**
 * The tenant the user is currently acting in. A user can belong to more than one;
 * the choice is remembered in a cookie and falls back to the first membership. The
 * cookie value is validated against the user's actual memberships every time, so a
 * stale or forged cookie can never select a tenant the user does not belong to.
 *
 * `memberships` may be passed in by a caller that has already loaded them for this
 * request, so the same table is not queried twice on one page render. When omitted it
 * is loaded here, so existing callers are unaffected.
 */
export async function currentTenant(
  userId: string,
  memberships?: MembershipRow[]
): Promise<MembershipRow | null> {
  const list = memberships ?? (await listMembershipsForUser(userId));
  if (list.length === 0) return null;

  const cookieStore = await cookies();
  const selected = cookieStore.get(TENANT_COOKIE)?.value;
  return list.find((m) => m.tenant_id === selected) ?? list[0]!;
}

/** As currentTenant, but sends a user with no tenant to onboarding. */
export async function requireTenant(
  userId: string,
  memberships?: MembershipRow[]
): Promise<MembershipRow> {
  const tenant = await currentTenant(userId, memberships);
  if (!tenant) redirect('/onboarding');
  return tenant;
}

export { TENANT_COOKIE };
