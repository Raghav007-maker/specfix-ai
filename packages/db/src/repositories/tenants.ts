/**
 * Tenants, memberships, projects, and readiness events.
 *
 * Small enough to live together; all four are setup-and-lifecycle rather than the
 * analysis hot path. `markReady` is the one with a rule attached: a ticket cannot be
 * marked ready while a flag on its current version is still open, because "ready for
 * development" with unanswered questions attached is the exact state the product
 * exists to eliminate.
 */
import { tx, query, type TenantId } from '../client.ts';

export interface TenantRow {
  id: string;
  name: string;
  monthly_token_cap: string;
}

export interface ProjectRow {
  id: string;
  tenant_id: string;
  name: string;
  source_type: 'file' | 'jira';
  jira_cloud_id: string | null;
  jira_project_key: string | null;
}

export async function createTenant(name: string): Promise<TenantRow> {
  const [tenant] = await query<TenantRow>(
    `insert into tenants (name) values ($1)
     returning id, name, monthly_token_cap`,
    [name]
  );
  if (!tenant) throw new Error('tenants insert returned no row');
  return tenant;
}

export async function addMembership(
  tenantId: TenantId,
  userId: string,
  role: 'owner' | 'admin' | 'reviewer' = 'reviewer'
): Promise<void> {
  await query(
    `insert into memberships (user_id, tenant_id, role) values ($1, $2, $3)
     on conflict (user_id, tenant_id) do update set role = excluded.role`,
    [userId, tenantId, role]
  );
}

export async function createProject(
  tenantId: TenantId,
  input: {
    name: string;
    sourceType: 'file' | 'jira';
    jiraCloudId?: string | undefined;
    jiraProjectKey?: string | undefined;
  }
): Promise<ProjectRow> {
  const [project] = await query<ProjectRow>(
    `insert into projects (tenant_id, name, source_type, jira_cloud_id, jira_project_key)
     values ($1, $2, $3, $4, $5)
     returning id, tenant_id, name, source_type, jira_cloud_id, jira_project_key`,
    [
      tenantId,
      input.name,
      input.sourceType,
      input.jiraCloudId ?? null,
      input.jiraProjectKey ?? null,
    ]
  );
  if (!project) throw new Error('projects insert returned no row');
  return project;
}

export async function listProjects(tenantId: TenantId): Promise<ProjectRow[]> {
  return query<ProjectRow>(
    `select id, tenant_id, name, source_type, jira_cloud_id, jira_project_key
     from projects where tenant_id = $1 order by name`,
    [tenantId]
  );
}

export interface MembershipRow {
  tenant_id: string;
  tenant_name: string;
  role: 'owner' | 'admin' | 'reviewer';
}

/**
 * The tenants a user belongs to. This is the one lookup that is legitimately
 * user-scoped rather than tenant-scoped: it is how a signed-in reviewer discovers
 * which tenant(s) they may act in before any tenant_id is known. It returns only
 * tenants the user is actually a member of, so it cannot leak another tenant's
 * existence. Every subsequent query is scoped by the tenant_id chosen from here.
 */
export async function listMembershipsForUser(userId: string): Promise<MembershipRow[]> {
  return query<MembershipRow>(
    `select m.tenant_id, t.name as tenant_name, m.role
     from memberships m
     join tenants t on t.id = m.tenant_id
     where m.user_id = $1
     order by t.name`,
    [userId]
  );
}

export type ReadinessEvent =
  'ticket_ingested' | 'analysis_complete' | 'all_flags_resolved' | 'marked_ready';

export interface ReadinessEventRow {
  id: string;
  ticket_id: string;
  ticket_version_id: string | null;
  event: ReadinessEvent;
  user_id: string | null;
  backfilled: boolean;
  occurred_at: Date;
}

export class ReadinessError extends Error {}

/**
 * Marks a ticket ready for development. Internal state only — Phase 1 never writes
 * back to Jira.
 */
export async function markReady(
  tenantId: TenantId,
  ticketId: string,
  userId: string
): Promise<ReadinessEventRow> {
  return tx(async (client) => {
    const current = await client.query<{ ticket_version_id: string; open_flags: string }>(
      `select v.id as ticket_version_id,
              (select count(*) from flags f
                where f.tenant_id = v.tenant_id
                  and f.ticket_version_id = v.id
                  and f.status = 'open')::text as open_flags
       from ticket_versions v
       where v.tenant_id = $1 and v.ticket_id = $2
       order by v.captured_at desc
       limit 1`,
      [tenantId, ticketId]
    );

    const row = current.rows[0];
    if (!row) throw new ReadinessError(`no analyzed version of ticket ${ticketId}`);
    if (Number(row.open_flags) > 0) {
      throw new ReadinessError(
        `${row.open_flags} flag(s) are still open on the current version; resolve them first`
      );
    }

    const inserted = await client.query<ReadinessEventRow>(
      `insert into readiness_events (tenant_id, ticket_id, ticket_version_id, event, user_id)
       values ($1, $2, $3, 'marked_ready', $4)
       returning id, ticket_id, ticket_version_id, event, user_id, backfilled, occurred_at`,
      [tenantId, ticketId, row.ticket_version_id, userId]
    );

    const event = inserted.rows[0];
    if (!event) throw new Error('readiness_events insert returned no row');
    return event;
  });
}

export async function listReadinessEvents(
  tenantId: TenantId,
  ticketId: string
): Promise<ReadinessEventRow[]> {
  return query<ReadinessEventRow>(
    `select id, ticket_id, ticket_version_id, event, user_id, backfilled, occurred_at
     from readiness_events
     where tenant_id = $1 and ticket_id = $2
     order by occurred_at`,
    [tenantId, ticketId]
  );
}

export interface ReadinessTimelineRow extends ReadinessEventRow {
  /** Null for system-generated events, which carry no user_id. */
  user_email: string | null;
}

/**
 * As listReadinessEvents, but resolves the actor's email for display.
 *
 * The join reaches into Supabase's auth.users. That is identity, not tenant data, and
 * the ids being resolved came out of rows already scoped to this tenant — so no
 * membership check is needed here and none is implied.
 */
export async function readinessTimeline(
  tenantId: TenantId,
  ticketId: string
): Promise<ReadinessTimelineRow[]> {
  return query<ReadinessTimelineRow>(
    `select e.id, e.ticket_id, e.ticket_version_id, e.event, e.user_id,
            e.backfilled, e.occurred_at, u.email as user_email
     from readiness_events e
     left join auth.users u on u.id = e.user_id
     where e.tenant_id = $1 and e.ticket_id = $2
     order by e.occurred_at`,
    [tenantId, ticketId]
  );
}

/**
 * Backfilled from Jira changelog history in week 6-7 to establish the "before tool"
 * baseline. Marked `backfilled` so it is never mistaken for an observed measurement.
 */
export async function recordBackfilledEvent(
  tenantId: TenantId,
  input: { ticketId: string; event: ReadinessEvent; occurredAt: Date }
): Promise<void> {
  await query(
    `insert into readiness_events (tenant_id, ticket_id, event, backfilled, occurred_at)
     values ($1, $2, $3, true, $4)`,
    [tenantId, input.ticketId, input.event, input.occurredAt]
  );
}

/**
 * Hours from first ingest to marked-ready, per ticket. Live and backfilled rows are
 * returned separately: mixing them would compare a measurement against an estimate
 * and call the difference an improvement.
 */
export interface TimeToReady {
  ticketId: string;
  hours: number;
  backfilled: boolean;
}

export async function timeToReady(tenantId: TenantId): Promise<TimeToReady[]> {
  const rows = await query<{ ticket_id: string; hours: string; backfilled: boolean }>(
    `select ticket_id,
            (extract(epoch from (max(occurred_at) filter (where event = 'marked_ready')
                               - min(occurred_at) filter (where event = 'ticket_ingested'))) / 3600)::text as hours,
            bool_or(backfilled) as backfilled
     from readiness_events
     where tenant_id = $1
     group by ticket_id
     having count(*) filter (where event = 'marked_ready') > 0
        and count(*) filter (where event = 'ticket_ingested') > 0`,
    [tenantId]
  );

  return rows.map((r) => ({
    ticketId: r.ticket_id,
    hours: Number(r.hours),
    backfilled: r.backfilled,
  }));
}
