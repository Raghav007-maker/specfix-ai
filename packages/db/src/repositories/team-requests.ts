/**
 * Finding a team and asking to join it, and asking for a project.
 *
 *   - Anyone signed in can search teams by name and ask to join one they are not in. The
 *     workspace owner approves (the person joins as a reviewer, in no project yet — a project
 *     admin adds them to projects) or rejects.
 *   - An admin (a workspace admin, or admin of a project) can ask for a new project. The owner
 *     approves: the project is created and the requester becomes its admin.
 *
 * Every decision runs in one transaction on the locked request row, so two clicks admit a
 * person, or create a project, exactly once. Only owners decide; everyone else gets the same
 * "no such request" answer as for an id that does not exist.
 */
import { tx, query, type TenantId } from '../client.ts';
import { assertProjectRoom } from './plans.ts';

export class RequestError extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_REQUEST = 'That request was not found.';

export interface TeamHit {
  id: string;
  name: string;
  /** Whether the user already has a pending request to this team. */
  requested: boolean;
}

/** "a_b%" → "a\_b\%": the search text is a literal, not a pattern. */
const literal = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Teams whose name contains `text` (at least 3 characters) that the user is not in; 8 at most. */
export async function searchTeams(userId: string, text: string): Promise<TeamHit[]> {
  const q = text.trim().replace(/\s+/g, ' ').slice(0, 100);
  if (!UUID.test(userId) || q.length < 3) return [];
  return query<TeamHit>(
    `select t.id, t.name,
            exists (select 1 from team_join_requests r
                    where r.tenant_id = t.id and r.user_id = $1 and r.status = 'pending')
              as requested
     from tenants t
     where t.name ilike $2 escape '\\'
       and not exists (select 1 from memberships m where m.tenant_id = t.id and m.user_id = $1)
     order by t.name
     limit 8`,
    [userId, `%${literal(q)}%`]
  );
}

/** Asks to join a team. Refused for a member, a missing team, or a second pending request. */
export async function requestToJoin(userId: string, tenantId: string): Promise<void> {
  if (!UUID.test(userId) || !UUID.test(tenantId))
    throw new RequestError('That team was not found.');
  await tx(async (client) => {
    const { rowCount: team } = await client.query(`select 1 from tenants where id = $1`, [
      tenantId,
    ]);
    if (!team) throw new RequestError('That team was not found.');
    const { rowCount: member } = await client.query(
      `select 1 from memberships where tenant_id = $1 and user_id = $2`,
      [tenantId, userId]
    );
    if (member) throw new RequestError('You are already in this team.');
    const { rowCount } = await client.query(
      `insert into team_join_requests (tenant_id, user_id) values ($1, $2)
       on conflict (tenant_id, user_id) where status = 'pending' do nothing`,
      [tenantId, userId]
    );
    if (!rowCount) throw new RequestError('You already asked to join this team.');
  });
}

export interface MyRequestRow {
  id: string;
  tenant_name: string;
  status: 'pending' | 'approved' | 'rejected';
  created_at: Date;
}

/** The user's own recent requests, newest first. */
export async function listMyJoinRequests(userId: string): Promise<MyRequestRow[]> {
  if (!UUID.test(userId)) return [];
  return query<MyRequestRow>(
    `select r.id, t.name as tenant_name, r.status, r.created_at
     from team_join_requests r join tenants t on t.id = r.tenant_id
     where r.user_id = $1 order by r.created_at desc limit 10`,
    [userId]
  );
}

export interface JoinRequestRow {
  id: string;
  user_id: string;
  email: string | null;
  created_at: Date;
}

async function isOwner(
  client: { query: (sql: string, params: unknown[]) => Promise<{ rowCount: number | null }> },
  tenantId: TenantId,
  userId: string
): Promise<boolean> {
  const { rowCount } = await client.query(
    `select 1 from memberships where tenant_id = $1 and user_id = $2 and role = 'owner'`,
    [tenantId, userId]
  );
  return Boolean(rowCount);
}

/** Pending requests to join this team; empty for anyone but an owner. */
export async function listJoinRequests(
  tenantId: TenantId,
  actorId: string
): Promise<JoinRequestRow[]> {
  if (!UUID.test(actorId)) return [];
  return query<JoinRequestRow>(
    `select r.id, r.user_id, u.email, r.created_at
     from team_join_requests r
     left join auth.users u on u.id = r.user_id
     where r.tenant_id = $1 and r.status = 'pending'
       and exists (select 1 from memberships m
                   where m.tenant_id = $1 and m.user_id = $2 and m.role = 'owner')
     order by r.created_at`,
    [tenantId, actorId]
  );
}

/** The owner approves (the person becomes a reviewer) or rejects a join request. */
export async function decideJoinRequest(
  tenantId: TenantId,
  actorId: string,
  requestId: string,
  approve: boolean
): Promise<void> {
  if (!UUID.test(requestId) || !UUID.test(actorId)) throw new RequestError(NO_REQUEST);
  await tx(async (client) => {
    if (!(await isOwner(client, tenantId, actorId))) throw new RequestError(NO_REQUEST);
    const {
      rows: [request],
    } = await client.query<{ user_id: string }>(
      `select user_id from team_join_requests
       where tenant_id = $1 and id = $2 and status = 'pending' for update`,
      [tenantId, requestId]
    );
    if (!request) throw new RequestError(NO_REQUEST);
    if (approve) {
      await client.query(
        `insert into memberships (user_id, tenant_id, role) values ($1, $2, 'reviewer')
         on conflict (user_id, tenant_id) do nothing`,
        [request.user_id, tenantId]
      );
    }
    await client.query(
      `update team_join_requests set status = $3, decided_by = $4, decided_at = now()
       where tenant_id = $1 and id = $2`,
      [tenantId, requestId, approve ? 'approved' : 'rejected', actorId]
    );
  });
}

// ---------------------------------------------------------------------------
// Project requests
// ---------------------------------------------------------------------------

/** Whether the user is a workspace admin or the admin of any project here (not an owner). */
export async function canRequestProject(tenantId: TenantId, userId: string): Promise<boolean> {
  if (!UUID.test(userId)) return false;
  const rows = await query(
    `select 1 from memberships m
     where m.tenant_id = $1 and m.user_id = $2 and m.role = 'admin'
     union all
     select 1 from project_members pm
     where pm.tenant_id = $1 and pm.user_id = $2 and pm.role = 'admin'
     limit 1`,
    [tenantId, userId]
  );
  return rows.length > 0;
}

/** An admin asks the owner for a new project. At most 3 open requests per person. */
export async function requestProject(
  tenantId: TenantId,
  actorId: string,
  rawName: string
): Promise<void> {
  const name = rawName.trim().replace(/\s+/g, ' ');
  if (!name) throw new RequestError('A project name is required.');
  if (name.length > 100) throw new RequestError('A project name can be at most 100 characters.');
  if (!(await canRequestProject(tenantId, actorId))) {
    throw new RequestError('Only admins can ask for a project. Owners create them directly.');
  }
  await tx(async (client) => {
    await client.query(`select pg_advisory_xact_lock(hashtext('specfix_project_req:' || $1))`, [
      actorId,
    ]);
    const {
      rows: [open],
    } = await client.query<{ n: number }>(
      `select count(*)::int as n from project_requests
       where tenant_id = $1 and requested_by = $2 and status = 'pending'`,
      [tenantId, actorId]
    );
    if ((open?.n ?? 0) >= 3) {
      throw new RequestError('You already have 3 projects waiting for approval.');
    }
    await client.query(
      `insert into project_requests (tenant_id, requested_by, name) values ($1, $2, $3)`,
      [tenantId, actorId, name]
    );
  });
}

export interface ProjectRequestRow {
  id: string;
  name: string;
  requested_by: string;
  email: string | null;
  status: 'pending' | 'approved' | 'rejected';
  created_at: Date;
}

/**
 * The owner sees every request of the workspace, anyone else only their own; pending first.
 */
export async function listProjectRequests(
  tenantId: TenantId,
  actorId: string
): Promise<ProjectRequestRow[]> {
  if (!UUID.test(actorId)) return [];
  return query<ProjectRequestRow>(
    `select r.id, r.name, r.requested_by, u.email, r.status, r.created_at
     from project_requests r
     left join auth.users u on u.id = r.requested_by
     where r.tenant_id = $1
       and (r.requested_by = $2
            or exists (select 1 from memberships m
                       where m.tenant_id = $1 and m.user_id = $2 and m.role = 'owner'))
     order by (r.status = 'pending') desc, r.created_at desc
     limit 30`,
    [tenantId, actorId]
  );
}

/**
 * The owner approves — the project is created (the plan's project limit applies unless
 * `unlimited`) and the requester becomes its admin — or rejects a project request.
 */
export async function decideProjectRequest(
  tenantId: TenantId,
  actorId: string,
  requestId: string,
  approve: boolean,
  options: { unlimited?: boolean } = {}
): Promise<{ projectId: string | null }> {
  if (!UUID.test(requestId) || !UUID.test(actorId)) throw new RequestError(NO_REQUEST);
  return tx(async (client) => {
    if (!(await isOwner(client, tenantId, actorId))) throw new RequestError(NO_REQUEST);
    const {
      rows: [request],
    } = await client.query<{ name: string; requested_by: string }>(
      `select name, requested_by from project_requests
       where tenant_id = $1 and id = $2 and status = 'pending' for update`,
      [tenantId, requestId]
    );
    if (!request) throw new RequestError(NO_REQUEST);

    let projectId: string | null = null;
    if (approve) {
      const { rowCount: stillMember } = await client.query(
        `select 1 from memberships where tenant_id = $1 and user_id = $2 and role <> 'owner'`,
        [tenantId, request.requested_by]
      );
      if (!stillMember) throw new RequestError('The person who asked is no longer on the team.');
      if (!options.unlimited) await assertProjectRoom(client, tenantId);
      const {
        rows: [project],
      } = await client.query<{ id: string }>(
        `insert into projects (tenant_id, name, source_type) values ($1, $2, 'file') returning id`,
        [tenantId, request.name]
      );
      if (!project) throw new Error('projects insert returned no row');
      projectId = project.id;
      await client.query(
        `insert into project_members (tenant_id, project_id, user_id, role, added_by)
         values ($1, $2, $3, 'admin', $4)`,
        [tenantId, projectId, request.requested_by, actorId]
      );
    }
    await client.query(
      `update project_requests
       set status = $3, project_id = $4, decided_by = $5, decided_at = now()
       where tenant_id = $1 and id = $2`,
      [tenantId, requestId, approve ? 'approved' : 'rejected', projectId, actorId]
    );
    return { projectId };
  });
}
