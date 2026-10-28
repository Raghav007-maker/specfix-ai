/**
 * Notifications: the inbox rows, who receives them, preferences, and the queries the
 * email delivery and the daily digest read.
 *
 * Recipients follow the roles that exist today (owner / admin / reviewer): events that
 * need a decision go to owners and admins; a sign-off goes to everyone in the workspace
 * except the person who signed off. When per-ticket owners land, notifyTicketEvent is
 * the one place that changes.
 *
 * pendingEmailTenants and the digest query are the cross-tenant reads (the worker
 * serves every tenant); each returns tenant ids for the caller to scope by.
 */
import { query, type TenantId } from '../client.ts';

export const NOTIFICATION_KINDS = [
  'flags_ready',
  'flags_stale',
  'signed_off',
  'ci_failed',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export interface NotificationRow {
  id: string;
  kind: NotificationKind;
  ticket_id: string | null;
  payload: Record<string, unknown>;
  read_at: Date | null;
  created_at: Date;
}

/** Who hears about each kind of event. */
const AUDIENCE: Record<NotificationKind, 'deciders' | 'everyone'> = {
  flags_ready: 'deciders',
  flags_stale: 'deciders',
  ci_failed: 'deciders',
  signed_off: 'everyone',
};

/**
 * Creates one notification per recipient for a ticket event. Ticket key and title are
 * read here, so callers pass ids and counts only. Returns how many were created.
 */
export async function notifyTicketEvent(
  tenantId: TenantId,
  input: {
    kind: NotificationKind;
    ticketId: string;
    actorId?: string | null;
    details?: Record<string, unknown>;
  }
): Promise<number> {
  const roles =
    AUDIENCE[input.kind] === 'deciders' ? ['owner', 'admin'] : ['owner', 'admin', 'reviewer'];
  const rows = await query(
    `insert into notifications (tenant_id, user_id, kind, ticket_id, payload)
     select m.tenant_id, m.user_id, $3, t.id,
            jsonb_build_object('key', t.external_key, 'title', t.title) || $5::jsonb
     from memberships m
     join tickets t on t.tenant_id = m.tenant_id and t.id = $2
     where m.tenant_id = $1 and m.role = any($4::text[])
       and ($6::uuid is null or m.user_id <> $6::uuid)
     returning 1`,
    [
      tenantId,
      input.ticketId,
      input.kind,
      roles,
      JSON.stringify(input.details ?? {}),
      input.actorId ?? null,
    ]
  );
  return rows.length;
}

export async function listNotifications(
  tenantId: TenantId,
  userId: string,
  limit = 50
): Promise<NotificationRow[]> {
  return query<NotificationRow>(
    `select id, kind, ticket_id, payload, read_at, created_at from notifications
     where tenant_id = $1 and user_id = $2
     order by created_at desc limit $3`,
    [tenantId, userId, limit]
  );
}

export async function unreadNotificationCount(tenantId: TenantId, userId: string): Promise<number> {
  const [row] = await query<{ n: string }>(
    `select count(*)::text as n from notifications
     where tenant_id = $1 and user_id = $2 and read_at is null`,
    [tenantId, userId]
  );
  return Number(row?.n ?? 0);
}

/** Marks the user's notifications read: one id, or all of them when `id` is null. */
export async function markNotificationsRead(
  tenantId: TenantId,
  userId: string,
  id: string | null
): Promise<void> {
  await query(
    `update notifications set read_at = now()
     where tenant_id = $1 and user_id = $2 and read_at is null and ($3::uuid is null or id = $3::uuid)`,
    [tenantId, userId, id]
  );
}

export interface NotificationPrefs {
  email_instant: boolean;
  email_digest: 'off' | 'daily';
}

export async function getNotificationPrefs(
  tenantId: TenantId,
  userId: string
): Promise<NotificationPrefs> {
  const [row] = await query<NotificationPrefs>(
    `select email_instant, email_digest from notification_prefs
     where tenant_id = $1 and user_id = $2`,
    [tenantId, userId]
  );
  return row ?? { email_instant: true, email_digest: 'daily' };
}

export async function setNotificationPrefs(
  tenantId: TenantId,
  userId: string,
  prefs: NotificationPrefs
): Promise<void> {
  await query(
    `insert into notification_prefs (tenant_id, user_id, email_instant, email_digest)
     values ($1, $2, $3, $4)
     on conflict (tenant_id, user_id) do update
       set email_instant = excluded.email_instant, email_digest = excluded.email_digest`,
    [tenantId, userId, prefs.email_instant, prefs.email_digest]
  );
}

/** Tenants with notifications whose email has not been decided yet. */
export async function pendingEmailTenants(): Promise<string[]> {
  const rows = await query<{ tenant_id: string }>(
    `select distinct tenant_id from notifications where email_status = 'pending'`
  );
  return rows.map((r) => r.tenant_id);
}

export interface PendingEmailRow {
  id: string;
  user_id: string;
  email: string | null;
  kind: NotificationKind;
  ticket_id: string | null;
  payload: Record<string, unknown>;
  email_instant: boolean;
  /** An instant email about the same ticket already went to this user in the last hour. */
  recently_emailed: boolean;
}

export async function pendingEmails(tenantId: TenantId, limit = 100): Promise<PendingEmailRow[]> {
  return query<PendingEmailRow>(
    `select n.id, n.user_id, u.email, n.kind, n.ticket_id, n.payload,
            coalesce(p.email_instant, true) as email_instant,
            exists (
              select 1 from notifications s
              where s.tenant_id = n.tenant_id and s.user_id = n.user_id
                and s.ticket_id is not distinct from n.ticket_id
                and s.email_status = 'sent' and s.emailed_at > now() - interval '1 hour'
            ) as recently_emailed
     from notifications n
     left join auth.users u on u.id = n.user_id
     left join notification_prefs p on p.tenant_id = n.tenant_id and p.user_id = n.user_id
     where n.tenant_id = $1 and n.email_status = 'pending'
     order by n.created_at
     limit $2`,
    [tenantId, limit]
  );
}

export async function setEmailStatus(
  tenantId: TenantId,
  id: string,
  status: 'sent' | 'skipped' | 'failed'
): Promise<void> {
  await query(
    `update notifications
     set email_status = $3, emailed_at = case when $3 = 'sent' then now() else emailed_at end
     where tenant_id = $1 and id = $2`,
    [tenantId, id, status]
  );
}

export interface DigestRecipient {
  tenant_id: string;
  tenant_name: string;
  user_id: string;
  email: string;
}

/**
 * Users due a daily digest: digest on, no digest in the last ~day, and something to say
 * — unread notifications, or open flags on the workspace's tickets.
 */
export async function dueDigestRecipients(): Promise<DigestRecipient[]> {
  return query<DigestRecipient>(
    `select m.tenant_id, te.name as tenant_name, m.user_id, u.email
     from memberships m
     join tenants te on te.id = m.tenant_id
     join auth.users u on u.id = m.user_id and u.email is not null
     left join notification_prefs p on p.tenant_id = m.tenant_id and p.user_id = m.user_id
     left join digest_runs d on d.tenant_id = m.tenant_id and d.user_id = m.user_id
     where coalesce(p.email_digest, 'daily') = 'daily'
       and (d.sent_at is null or d.sent_at < now() - interval '23 hours')
       and exists (select 1 from notifications n
                   where n.tenant_id = m.tenant_id and n.user_id = m.user_id
                     and n.read_at is null)`
  );
}

export interface DigestContent {
  unread: Array<{
    kind: NotificationKind;
    ticket_id: string | null;
    payload: Record<string, unknown>;
  }>;
  /** Tickets whose current version has had open flags for 3+ days. */
  stuck: Array<{ ticket_id: string; external_key: string; title: string; open_flags: number }>;
}

export async function digestContent(tenantId: TenantId, userId: string): Promise<DigestContent> {
  const unread = await query<DigestContent['unread'][number]>(
    `select kind, ticket_id, payload from notifications
     where tenant_id = $1 and user_id = $2 and read_at is null
     order by created_at desc limit 20`,
    [tenantId, userId]
  );
  const stuck = await query<DigestContent['stuck'][number]>(
    `select t.id as ticket_id, t.external_key, t.title, count(f.id)::int as open_flags
     from tickets t
     join lateral (select id from ticket_versions v
                   where v.tenant_id = t.tenant_id and v.ticket_id = t.id
                   order by v.captured_at desc limit 1) cv on true
     join flags f on f.tenant_id = t.tenant_id and f.ticket_version_id = cv.id
                 and f.status = 'open' and f.created_at < now() - interval '3 days'
     where t.tenant_id = $1 and t.archived_at is null
     group by t.id
     order by count(f.id) desc
     limit 10`,
    [tenantId]
  );
  return { unread, stuck };
}

export async function recordDigestSent(tenantId: TenantId, userId: string): Promise<void> {
  await query(
    `insert into digest_runs (tenant_id, user_id) values ($1, $2)
     on conflict (tenant_id, user_id) do update set sent_at = now()`,
    [tenantId, userId]
  );
}
