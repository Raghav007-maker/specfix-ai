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
 */
export async function currentTenant(userId: string): Promise<MembershipRow | null> {
  const memberships = await listMembershipsForUser(userId);
  if (memberships.length === 0) return null;

  const cookieStore = await cookies();
  const selected = cookieStore.get(TENANT_COOKIE)?.value;
  return memberships.find((m) => m.tenant_id === selected) ?? memberships[0]!;
}

/** As currentTenant, but sends a user with no tenant to onboarding. */
export async function requireTenant(userId: string): Promise<MembershipRow> {
  const tenant = await currentTenant(userId);
  if (!tenant) redirect('/onboarding');
  return tenant;
}

export { TENANT_COOKIE };
