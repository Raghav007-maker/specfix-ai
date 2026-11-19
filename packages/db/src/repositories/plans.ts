/**
 * Workspace plans: Free (five projects, five admins and reviewers, no resolution agent) and Pro
 * (pro_until in the future: any number of projects, ten admins and reviewers). SpecFix's own
 * team — the app owners — get everything, in any workspace.
 *
 * The project limit is checked in the same transaction as the insert, under a lock on the
 * tenant row, so parallel "create project" requests cannot both take the last slot.
 */
import type { PoolClient } from 'pg';
import { FREE_MEMBER_LIMIT, FREE_PROJECT_LIMIT, PRO_MEMBER_LIMIT } from '@specfix/shared';
import { query, type TenantId } from '../client.ts';

export { FREE_MEMBER_LIMIT, FREE_PROJECT_LIMIT, PRO_MEMBER_LIMIT };
/** Days before Pro ends that the renewal notice appears. */
export const RENEW_NOTICE_DAYS = 3;
/** Days after Pro ended that the lapsed notice stays. */
export const LAPSED_NOTICE_DAYS = 7;

const DAY_MS = 86_400_000;

/** Refused because the workspace is on Free and already has its five projects. Shown as-is. */
export class ProjectLimitError extends Error {
  constructor() {
    super(`The Free plan allows ${FREE_PROJECT_LIMIT} projects. Upgrade to Pro to add more.`);
  }
}

export interface TenantPlan {
  pro: boolean;
  proUntil: Date | null;
  projectCount: number;
  /** Admins and reviewers; owners do not count toward the limit. */
  memberCount: number;
  memberLimit: number;
  /** False while a new workspace waits for its one-time fee. */
  open: boolean;
}

export function isPro(proUntil: Date | null, now: Date = new Date()): boolean {
  return proUntil !== null && proUntil.getTime() > now.getTime();
}

/**
 * Whether a signed-in user is one of SpecFix's own team, listed in SPECFIX_OWNER_EMAILS
 * (comma-separated). Only a confirmed address counts, so nobody can sign up with an owner's
 * email and inherit the exemption.
 */
export function isAppOwnerEmail(
  ownerList: string | undefined,
  email: string | undefined,
  emailConfirmed: boolean
): boolean {
  if (!ownerList || !email || !emailConfirmed) return false;
  const wanted = email.trim().toLowerCase();
  return ownerList
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .some((e) => e !== '' && e === wanted);
}

export type PlanNotice =
  | { kind: 'renew'; on: Date }
  | { kind: 'lapsed'; on: Date }
  | { kind: 'near-limit' | 'at-limit'; used: number; limit: number };

/**
 * The one notice worth showing in the top bar, if any: Pro ending soon or just ended, or a
 * Free workspace close to its project limit. Pro ending wins, since it changes the most.
 */
export function planNotice(plan: TenantPlan, now: Date = new Date()): PlanNotice | null {
  if (plan.proUntil) {
    const left = plan.proUntil.getTime() - now.getTime();
    if (left > 0 && left <= RENEW_NOTICE_DAYS * DAY_MS) return { kind: 'renew', on: plan.proUntil };
    if (left <= 0 && -left <= LAPSED_NOTICE_DAYS * DAY_MS) {
      return { kind: 'lapsed', on: plan.proUntil };
    }
  }
  if (plan.pro) return null;
  if (plan.projectCount >= FREE_PROJECT_LIMIT) {
    return { kind: 'at-limit', used: plan.projectCount, limit: FREE_PROJECT_LIMIT };
  }
  if (plan.projectCount === FREE_PROJECT_LIMIT - 1) {
    return { kind: 'near-limit', used: plan.projectCount, limit: FREE_PROJECT_LIMIT };
  }
  return null;
}

/** Whether the resolution agent runs: never with its flag off, always for the app owners. */
export type AgentAccess = 'on' | 'locked' | 'off';

export function agentAccessFor(input: {
  enabled: boolean;
  appOwner: boolean;
  pro: boolean;
}): AgentAccess {
  if (!input.enabled) return 'off';
  return input.appOwner || input.pro ? 'on' : 'locked';
}

/** What the Pro card's button offers on the pricing page. 'extend' pays for more Pro. */
export type ProCta = 'current' | 'extend' | 'upgrade' | 'ask-admin' | 'team';

/** Only the workspace owner pays; anyone else is told to ask them. */
export function proCta(input: {
  pro: boolean;
  appOwner: boolean;
  role: 'owner' | 'admin' | 'reviewer';
}): ProCta {
  if (input.appOwner) return 'team';
  const payer = input.role === 'owner';
  if (input.pro) return payer ? 'extend' : 'current';
  return payer ? 'upgrade' : 'ask-admin';
}

export async function tenantPlan(tenantId: TenantId): Promise<TenantPlan> {
  const [row] = await query<{
    pro_until: Date | null;
    project_count: string;
    member_count: string;
    open: boolean;
  }>(
    `select t.pro_until, t.activated_at is not null as open,
            (select count(*) from projects p where p.tenant_id = t.id) as project_count,
            (select count(*) from memberships m
             where m.tenant_id = t.id and m.role <> 'owner') as member_count
     from tenants t where t.id = $1`,
    [tenantId]
  );
  if (!row) throw new Error('tenant not found');
  const pro = isPro(row.pro_until);
  return {
    pro,
    proUntil: row.pro_until,
    projectCount: Number(row.project_count),
    memberCount: Number(row.member_count),
    memberLimit: pro ? PRO_MEMBER_LIMIT : FREE_MEMBER_LIMIT,
    open: row.open,
  };
}

/** Operator action: grant Pro until a date, or return the workspace to Free with null. */
export async function setProUntil(tenantId: TenantId, proUntil: Date | null): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `update tenants set pro_until = $2 where id = $1 returning id`,
    [tenantId, proUntil]
  );
  return rows.length === 1;
}

/**
 * Throws ProjectLimitError when a Free workspace has no project slot left. Call inside the
 * transaction that inserts the project: the tenant row stays locked until it commits.
 */
export async function assertProjectRoom(client: PoolClient, tenantId: TenantId): Promise<void> {
  const tenant = await client.query<{ pro_until: Date | null }>(
    `select pro_until from tenants where id = $1 for update`,
    [tenantId]
  );
  const row = tenant.rows[0];
  if (!row) throw new Error('tenant not found');
  if (isPro(row.pro_until)) return;
  const count = await client.query<{ n: string }>(
    `select count(*) as n from projects where tenant_id = $1`,
    [tenantId]
  );
  if (Number(count.rows[0]?.n ?? 0) >= FREE_PROJECT_LIMIT) throw new ProjectLimitError();
}

/**
 * Why one more admin or reviewer cannot join, or null if they can: Free takes five, Pro ten
 * (owners are not counted). Call inside the transaction that adds the membership; the tenant
 * row stays locked until it commits, so parallel approvals cannot both take the last seat.
 */
export async function memberRoomRefusal(
  client: PoolClient,
  tenantId: TenantId
): Promise<string | null> {
  const tenant = await client.query<{ pro_until: Date | null }>(
    `select pro_until from tenants where id = $1 for update`,
    [tenantId]
  );
  const row = tenant.rows[0];
  if (!row) return 'That workspace was not found.';
  const pro = isPro(row.pro_until);
  const limit = pro ? PRO_MEMBER_LIMIT : FREE_MEMBER_LIMIT;
  const count = await client.query<{ n: string }>(
    `select count(*) as n from memberships where tenant_id = $1 and role <> 'owner'`,
    [tenantId]
  );
  if (Number(count.rows[0]?.n ?? 0) < limit) return null;
  return pro
    ? `The Pro plan allows ${limit} admins and reviewers. This workspace is full.`
    : `The Free plan allows ${limit} admins and reviewers. The owner can upgrade to Pro for ${PRO_MEMBER_LIMIT}.`;
}
