/**
 * Who works on which project, and the time they log on its tasks.
 *
 * A workspace owner sees every project. Everyone else sees only the projects they are a
 * member of (`project_members`), as that project's admin or a reviewer:
 *
 *   - owner     adds anyone in the workspace to a project as admin or reviewer, changes or
 *               removes them;
 *   - admin     adds reviewers to their project, promotes a reviewer to admin, removes a
 *               reviewer; cannot demote or remove another admin;
 *   - reviewer  changes nobody.
 *
 * A project someone cannot see is answered exactly like a project that does not exist, so
 * ids cannot be probed. Nobody changes their own project role.
 */
import type { PoolClient } from 'pg';
import { tx, query, type TenantId } from '../client.ts';
import type { ProjectRow } from './tenants.ts';
import type { MemberRow } from './members.ts';

export const PROJECT_ROLES = ['admin', 'reviewer'] as const;
export type ProjectMemberRole = (typeof PROJECT_ROLES)[number];
/** What a person is in a project: a workspace owner, or the project's admin or reviewer. */
export type ProjectRole = 'owner' | ProjectMemberRole;

export class ProjectAccessError extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_FOUND = 'That project is not in this workspace.';

type Queryable = Pick<PoolClient, 'query'>;

export function isProjectMemberRole(value: unknown): value is ProjectMemberRole {
  return typeof value === 'string' && (PROJECT_ROLES as readonly string[]).includes(value);
}

/**
 * Whether `actor` may move a person from `from` to `to` in a project (null `from`: not yet
 * in it; null `to`: removed).
 */
export function canChangeProjectMember(
  actor: ProjectRole | null,
  from: ProjectMemberRole | null,
  to: ProjectMemberRole | null
): boolean {
  if (actor === 'owner') return from !== to;
  if (actor !== 'admin') return false;
  if (from === 'admin') return false; // an admin never demotes or removes another admin
  if (from === null) return to === 'reviewer';
  return to === 'admin' || to === null; // reviewer → admin, or removed
}

const ROLE_SQL = `
  select case when m.role = 'owner' then 'owner' else pm.role end as role
  from memberships m
  join projects p on p.tenant_id = m.tenant_id and p.id = $2
  left join project_members pm
    on pm.tenant_id = m.tenant_id and pm.project_id = p.id and pm.user_id = m.user_id
  where m.tenant_id = $1 and m.user_id = $3`;

/** The user's role in the project, or null when they cannot see it (or it does not exist). */
export async function projectRoleWith(
  client: Queryable,
  tenantId: TenantId,
  projectId: string,
  userId: string
): Promise<ProjectRole | null> {
  if (!UUID.test(projectId) || !UUID.test(userId)) return null;
  const { rows } = await client.query<{ role: ProjectRole | null }>(ROLE_SQL, [
    tenantId,
    projectId,
    userId,
  ]);
  return rows[0]?.role ?? null;
}

export async function projectRole(
  tenantId: TenantId,
  projectId: string,
  userId: string
): Promise<ProjectRole | null> {
  if (!UUID.test(projectId) || !UUID.test(userId)) return null;
  const [row] = await query<{ role: ProjectRole | null }>(ROLE_SQL, [tenantId, projectId, userId]);
  return row?.role ?? null;
}

export interface VisibleProjectRow extends ProjectRow {
  /** The user's role in this project. */
  role: ProjectRole;
}

/**
 * The projects the user can see, in every workspace they belong to, in one query: all of a
 * workspace they own, else the ones they are a member of. User-scoped like
 * listMembershipsForUser (it runs before a workspace is picked); the join on memberships means
 * it only ever returns the user's own workspaces, and the caller keeps the one it verified.
 */
export async function listProjectsForUser(userId: string): Promise<VisibleProjectRow[]> {
  if (!UUID.test(userId)) return [];
  return query<VisibleProjectRow>(
    `select p.id, p.tenant_id, p.name, p.source_type, p.jira_cloud_id, p.jira_project_key,
            case when m.role = 'owner' then 'owner' else pm.role end as role
     from projects p
     join memberships m on m.tenant_id = p.tenant_id and m.user_id = $1
     left join project_members pm
       on pm.tenant_id = p.tenant_id and pm.project_id = p.id and pm.user_id = $1
     where m.role = 'owner' or pm.user_id is not null
     order by p.name`,
    [userId]
  );
}

/** As listProjectsForUser, for one workspace. */
export async function listVisibleProjects(
  tenantId: TenantId,
  userId: string
): Promise<VisibleProjectRow[]> {
  return (await listProjectsForUser(userId)).filter((p) => p.tenant_id === tenantId);
}

export interface ProjectMemberRow {
  user_id: string;
  email: string | null;
  name: string | null;
  role: ProjectMemberRole;
  created_at: Date;
}

/** A project's admins and reviewers, admins first. */
export async function listProjectMembers(
  tenantId: TenantId,
  projectId: string
): Promise<ProjectMemberRow[]> {
  if (!UUID.test(projectId)) return [];
  return query<ProjectMemberRow>(
    `select pm.user_id, u.email, pm.role, pm.created_at,
            left(nullif(trim(coalesce(u.raw_user_meta_data ->> 'full_name',
                                      u.raw_user_meta_data ->> 'name')), ''), 100) as name
     from project_members pm
     left join auth.users u on u.id = pm.user_id
     where pm.tenant_id = $1 and pm.project_id = $2
     order by case pm.role when 'admin' then 0 else 1 end, u.email nulls last`,
    [tenantId, projectId]
  );
}

export interface ProjectMembershipRow {
  project_id: string;
  project_name: string;
  user_id: string;
  role: ProjectMemberRole;
}

/** Every project membership in the workspace (for the Team page's per-person project list). */
export async function listProjectMemberships(tenantId: TenantId): Promise<ProjectMembershipRow[]> {
  return query<ProjectMembershipRow>(
    `select pm.project_id, p.name as project_name, pm.user_id, pm.role
     from project_members pm
     join projects p on p.id = pm.project_id and p.tenant_id = pm.tenant_id
     where pm.tenant_id = $1
     order by p.name`,
    [tenantId]
  );
}

/**
 * Adds a workspace member to a project, changes their role there, or removes them (role null).
 * The actor's role and the person's current one are read with the project's member rows locked,
 * so two admins acting at once cannot both pass a check the other's write would fail.
 */
export async function setProjectMember(
  tenantId: TenantId,
  actorId: string,
  input: { projectId: string; userId: string; role: ProjectMemberRole | null }
): Promise<void> {
  if (!UUID.test(input.projectId)) throw new ProjectAccessError(NOT_FOUND);
  if (!UUID.test(input.userId)) throw new ProjectAccessError('Choose someone from the team.');
  if (input.role !== null && !isProjectMemberRole(input.role)) {
    throw new ProjectAccessError('Choose admin or reviewer.');
  }
  if (input.userId === actorId) {
    throw new ProjectAccessError('You cannot change your own role in a project.');
  }

  await tx(async (client) => {
    const { rowCount } = await client.query(
      `select 1 from projects where tenant_id = $1 and id = $2 for update`,
      [tenantId, input.projectId]
    );
    if (!rowCount) throw new ProjectAccessError(NOT_FOUND);
    const actor = await projectRoleWith(client, tenantId, input.projectId, actorId);
    if (!actor) throw new ProjectAccessError(NOT_FOUND);

    const {
      rows: [target],
    } = await client.query<{ workspace_role: string; role: ProjectMemberRole | null }>(
      `select m.role as workspace_role, pm.role
       from memberships m
       left join project_members pm
         on pm.tenant_id = m.tenant_id and pm.project_id = $2 and pm.user_id = m.user_id
       where m.tenant_id = $1 and m.user_id = $3`,
      [tenantId, input.projectId, input.userId]
    );
    if (!target) throw new ProjectAccessError('That person is not on the team.');
    if (target.workspace_role === 'owner') {
      throw new ProjectAccessError('Owners already see every project.');
    }
    if (target.role === input.role) return;
    if (!canChangeProjectMember(actor, target.role, input.role)) {
      throw new ProjectAccessError(
        actor === 'admin'
          ? 'Project admins can add reviewers, make a reviewer an admin, or remove a reviewer.'
          : 'Only the owner or a project admin can change who is in this project.'
      );
    }

    if (input.role === null) {
      await client.query(
        `delete from project_members where tenant_id = $1 and project_id = $2 and user_id = $3`,
        [tenantId, input.projectId, input.userId]
      );
    } else {
      await client.query(
        `insert into project_members (tenant_id, project_id, user_id, role, added_by)
         values ($1, $2, $3, $4, $5)
         on conflict (project_id, user_id) do update set role = excluded.role`,
        [tenantId, input.projectId, input.userId, input.role, actorId]
      );
    }
  });
}

// ---------------------------------------------------------------------------
// Time logging
// ---------------------------------------------------------------------------

export const MAX_MINUTES_PER_ENTRY = 1440;
export const MAX_TIME_NOTE = 200;

export interface TimeEntryInput {
  minutes: number;
  spentOn: string;
  note: string;
}

/**
 * Checks one entry from a form: whole minutes 1–1440, a real calendar date no later than
 * tomorrow (time zones) and no more than a year back, and a note of at most 200 characters.
 */
export function normalizeTimeEntry(
  raw: { minutes?: unknown; spentOn?: unknown; note?: unknown },
  today: string = new Date().toISOString().slice(0, 10)
): TimeEntryInput {
  const minutes = typeof raw.minutes === 'number' ? raw.minutes : Number(String(raw.minutes ?? ''));
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_MINUTES_PER_ENTRY) {
    throw new ProjectAccessError('Log between 1 and 1440 minutes in one entry.');
  }
  const spentOn = String(raw.spentOn ?? '').trim();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(spentOn) ? new Date(`${spentOn}T00:00:00Z`) : null;
  if (!date || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== spentOn) {
    throw new ProjectAccessError('Choose the day the time was spent.');
  }
  const day = 86_400_000;
  const todayMs = new Date(`${today}T00:00:00Z`).getTime();
  if (date.getTime() > todayMs + day || date.getTime() < todayMs - 366 * day) {
    throw new ProjectAccessError('Time can be logged for the past year, up to today.');
  }
  const note = String(raw.note ?? '')
    .trim()
    .replace(/\s+/g, ' ');
  if (note.length > MAX_TIME_NOTE) {
    throw new ProjectAccessError(`A note can be at most ${MAX_TIME_NOTE} characters.`);
  }
  return { minutes, spentOn, note };
}

/** "95" → "1h 35m". */
export function formatMinutes(total: number): string {
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}

/** Logs the actor's own time on a task of a project they can see. */
export async function logTime(
  tenantId: TenantId,
  actorId: string,
  workItemId: string,
  raw: { minutes?: unknown; spentOn?: unknown; note?: unknown }
): Promise<{ projectId: string; number: number }> {
  const entry = normalizeTimeEntry(raw);
  if (!UUID.test(workItemId)) throw new ProjectAccessError('That task is not in this workspace.');
  return tx(async (client) => {
    const {
      rows: [item],
    } = await client.query<{ project_id: string; number: number }>(
      `select project_id, number from work_items where tenant_id = $1 and id = $2`,
      [tenantId, workItemId]
    );
    if (!item || !(await projectRoleWith(client, tenantId, item.project_id, actorId))) {
      throw new ProjectAccessError('That task is not in this workspace.');
    }
    await client.query(
      `insert into time_entries (tenant_id, project_id, work_item_id, user_id, minutes, spent_on, note)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [tenantId, item.project_id, workItemId, actorId, entry.minutes, entry.spentOn, entry.note]
    );
    return { projectId: item.project_id, number: item.number };
  });
}

/** Removes one of the actor's own entries. Someone else's entry is "not found". */
export async function deleteTimeEntry(
  tenantId: TenantId,
  actorId: string,
  entryId: string
): Promise<void> {
  if (!UUID.test(entryId)) throw new ProjectAccessError('That time entry was not found.');
  const rows = await query(
    `delete from time_entries where tenant_id = $1 and id = $2 and user_id = $3 returning id`,
    [tenantId, entryId, actorId]
  );
  if (rows.length === 0) throw new ProjectAccessError('That time entry was not found.');
}

export interface TimeEntryRow {
  id: string;
  user_id: string;
  email: string | null;
  minutes: number;
  spent_on: string;
  note: string;
  created_at: Date;
}

/** A task's time entries, newest first. */
export async function listTimeEntries(
  tenantId: TenantId,
  workItemId: string
): Promise<TimeEntryRow[]> {
  if (!UUID.test(workItemId)) return [];
  return query<TimeEntryRow>(
    `select e.id, e.user_id, u.email, e.minutes, e.spent_on::text as spent_on, e.note, e.created_at
     from time_entries e
     left join auth.users u on u.id = e.user_id
     where e.tenant_id = $1 and e.work_item_id = $2
     order by e.spent_on desc, e.created_at desc
     limit 200`,
    [tenantId, workItemId]
  );
}

// ---------------------------------------------------------------------------
// Tracking
// ---------------------------------------------------------------------------

export interface MemberTrackingRow {
  user_id: string;
  email: string | null;
  name: string | null;
  role: ProjectMemberRole;
  assigned: number;
  in_progress: number;
  done: number;
  overdue: number;
  minutes: number;
  last_active: Date | null;
}

/**
 * Per member of the project: their tasks by state, the minutes they logged, and when they last
 * did something here (changed a task, commented, or logged time). One query.
 */
export async function projectTracking(
  tenantId: TenantId,
  projectId: string
): Promise<MemberTrackingRow[]> {
  if (!UUID.test(projectId)) return [];
  return query<MemberTrackingRow>(
    `select pm.user_id, u.email, pm.role,
            left(nullif(trim(coalesce(u.raw_user_meta_data ->> 'full_name',
                                      u.raw_user_meta_data ->> 'name')), ''), 100) as name,
            coalesce(w.assigned, 0) as assigned, coalesce(w.in_progress, 0) as in_progress,
            coalesce(w.done, 0) as done, coalesce(w.overdue, 0) as overdue,
            coalesce(t.minutes, 0) as minutes,
            greatest(ev.last_at, t.last_at) as last_active
     from project_members pm
     left join auth.users u on u.id = pm.user_id
     left join lateral (
       select count(*)::int as assigned,
              (count(*) filter (where status in ('in_progress', 'in_review')))::int as in_progress,
              (count(*) filter (where status = 'done'))::int as done,
              (count(*) filter (where due_on < current_date and status <> 'done'))::int as overdue
       from work_items
       where tenant_id = pm.tenant_id and project_id = pm.project_id and assignee_id = pm.user_id
     ) w on true
     left join lateral (
       select sum(minutes)::int as minutes, max(created_at) as last_at
       from time_entries
       where tenant_id = pm.tenant_id and project_id = pm.project_id and user_id = pm.user_id
     ) t on true
     left join lateral (
       select max(created_at) as last_at
       from work_item_events
       where tenant_id = pm.tenant_id and project_id = pm.project_id and actor_id = pm.user_id
     ) ev on true
     where pm.tenant_id = $1 and pm.project_id = $2
     order by case pm.role when 'admin' then 0 else 1 end, u.email nulls last`,
    [tenantId, projectId]
  );
}

/**
 * Everyone who can see the project — the workspace's owners and the project's members — in
 * the shape of listMembers, for assignee pickers and @mentions.
 */
export async function listProjectPeople(
  tenantId: TenantId,
  projectId: string
): Promise<MemberRow[]> {
  if (!UUID.test(projectId)) return [];
  return query<MemberRow>(
    `select m.user_id, u.email, case when m.role = 'owner' then 'owner' else pm.role end as role,
            m.created_at,
            left(nullif(trim(coalesce(u.raw_user_meta_data ->> 'full_name',
                                      u.raw_user_meta_data ->> 'name')), ''), 100) as name,
            left(nullif(coalesce(u.raw_user_meta_data ->> 'avatar_url',
                                 u.raw_user_meta_data ->> 'picture'), ''), 500) as avatar_url
     from memberships m
     left join auth.users u on u.id = m.user_id
     left join project_members pm
       on pm.tenant_id = m.tenant_id and pm.project_id = $2 and pm.user_id = m.user_id
     where m.tenant_id = $1 and (m.role = 'owner' or pm.user_id is not null)
     order by case m.role when 'owner' then 0 else 1 end, u.email nulls last`,
    [tenantId, projectId]
  );
}
