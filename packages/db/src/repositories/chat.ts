/**
 * A project's team conversation, and @mentions there and in task comments.
 *
 * Everyone in the workspace reads and writes every project's conversation (the same people who
 * see its tasks). Writing `@name` — the part of a member's email before the @, or the whole
 * email — sends that member an inbox notification of kind 'mentioned', which the worker turns
 * into an email: a direct mention is the important case. `@all` (or `@everyone`) tells every
 * member in their inbox only — never by email — so one message cannot mail the whole team.
 * Only members of the workspace can be mentioned, never the author, and the notification is
 * written in the same transaction as the message.
 */
import type { PoolClient } from 'pg';
import { query, tx, type TenantId } from '../client.ts';

/** A refusal whose message is safe to show the user. */
export class ChatError extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_MESSAGE_LENGTH = 4000;
const MAX_MENTIONS = 20;

/** "udit@x.com" → "udit": what a member types after @ to mention them. */
export function handleOf(email: string | null): string | null {
  const local = email?.split('@')[0]?.trim().toLowerCase();
  return local || null;
}

/**
 * The handles a message mentions, lower-cased, de-duplicated, at most 20: `@udit`,
 * `@udit.bhatt` or `@udit@example.com`. An @ inside a word (an email address written out,
 * "a@b") is not a mention, and a trailing full stop or comma is not part of the handle.
 */
export function parseMentions(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(/(^|[^\w@.])@([a-z0-9._%+-]+(?:@[a-z0-9.-]+\.[a-z]{2,})?)/gi)) {
    const handle = m[2]!.replace(/[._%+-]+$/, '').toLowerCase();
    if (handle) out.add(handle);
    if (out.size >= MAX_MENTIONS) break;
  }
  return [...out];
}

/** Handles that mean the whole team: they notify in the inbox, never by email. */
export const EVERYONE_HANDLES: readonly string[] = ['all', 'everyone'];

/**
 * Who a message mentions (never the author): `direct` by email or the part before its @, and
 * `everyone` — the rest of the workspace — when it says @all or @everyone.
 */
async function mentionedMembers(
  client: PoolClient,
  tenantId: TenantId,
  body: string,
  authorId: string
): Promise<{ direct: string[]; everyone: string[] }> {
  const handles = parseMentions(body);
  if (handles.length === 0) return { direct: [], everyone: [] };
  const toAll = handles.some((h) => EVERYONE_HANDLES.includes(h));
  const named = handles.filter((h) => !EVERYONE_HANDLES.includes(h));
  const { rows } = await client.query<{ user_id: string; named: boolean }>(
    `select m.user_id,
            (lower(u.email) = any($2::text[])
             or lower(split_part(u.email, '@', 1)) = any($2::text[])) as named
     from memberships m
     join auth.users u on u.id = m.user_id
     where m.tenant_id = $1 and m.user_id <> $3`,
    [tenantId, named, authorId]
  );
  const direct = rows.filter((r) => r.named).map((r) => r.user_id);
  const everyone = toAll ? rows.filter((r) => !r.named).map((r) => r.user_id) : [];
  return { direct, everyone };
}

/**
 * Notifies the members `body` mentions, in the caller's transaction, and returns who was
 * notified: `direct` mentions get an email, `everyone` (@all) only an inbox entry. `skip` are
 * people already told about this event another way. Inside a savepoint, so a database without
 * migration 0022 skips the notification instead of failing the message.
 */
export async function notifyMentions(
  client: PoolClient,
  tenantId: TenantId,
  input: {
    body: string;
    actorId: string;
    payload: Record<string, unknown>;
    skip?: readonly (string | null)[];
  }
): Promise<{ direct: string[]; everyone: string[] }> {
  const none = { direct: [], everyone: [] };
  const skip = new Set(input.skip ?? []);
  const found = await mentionedMembers(client, tenantId, input.body, input.actorId);
  const direct = found.direct.filter((id) => !skip.has(id));
  const everyone = found.everyone.filter((id) => !skip.has(id));
  if (direct.length + everyone.length === 0) return none;
  await client.query('savepoint mention_notify');
  try {
    // A direct mention is emailed ('pending'); @all is inbox-only ('skipped' from the start).
    await client.query(
      `insert into notifications (tenant_id, user_id, kind, payload, email_status)
       select $1, m.user_id, 'mentioned',
              $2::jsonb || jsonb_build_object(
                'by', (select email from auth.users where id = $3::uuid),
                'excerpt', left($4::text, 200),
                'everyone', not (m.user_id = any($5::uuid[]))),
              case when m.user_id = any($5::uuid[]) then 'pending' else 'skipped' end
       from memberships m
       where m.tenant_id = $1 and m.user_id = any($6::uuid[])`,
      [
        tenantId,
        JSON.stringify(input.payload),
        input.actorId,
        input.body,
        direct,
        [...direct, ...everyone],
      ]
    );
    await client.query('release savepoint mention_notify');
    return { direct, everyone };
  } catch (error) {
    await client.query('rollback to savepoint mention_notify');
    console.warn('[chat] mention skipped:', error instanceof Error ? error.message : error);
    return none;
  }
}

export interface ProjectMessageRow {
  id: string;
  author_id: string | null;
  author_email: string | null;
  body: string;
  created_at: Date;
}

/** A project's conversation, oldest first: the most recent `limit` messages. */
export async function listProjectMessages(
  tenantId: TenantId,
  projectId: string,
  limit = 200
): Promise<ProjectMessageRow[]> {
  if (!UUID.test(projectId)) return [];
  const rows = await query<ProjectMessageRow>(
    `select m.id, m.author_id, u.email as author_email, m.body, m.created_at
     from project_messages m
     left join auth.users u on u.id = m.author_id
     where m.tenant_id = $1 and m.project_id = $2
     order by m.created_at desc, m.id
     limit $3`,
    [tenantId, projectId, Math.min(Math.max(limit, 1), 500)]
  );
  return rows.reverse();
}

let chatTableSeen = false;

/** Whether migration 0022 has been applied, so the page can say so instead of failing. */
export async function chatTablesAvailable(): Promise<boolean> {
  if (chatTableSeen) return true;
  const [row] = await query<{ available: boolean }>(
    `select to_regclass('public.project_messages') is not null as available`,
    []
  );
  chatTableSeen = row?.available === true;
  return chatTableSeen;
}

/** Trimmed message text; empty or over 4,000 characters is refused. */
export function normalizeMessage(raw: string | null | undefined): string {
  const body = (raw ?? '').replace(/\r\n/g, '\n').trim();
  if (!body) throw new ChatError('Write a message first.');
  if (body.length > MAX_MESSAGE_LENGTH) {
    throw new ChatError('A message can be at most 4,000 characters.');
  }
  return body;
}

/**
 * Posts to a project's conversation as a member of the workspace and notifies whoever it
 * @mentions. Returns the message id and who was mentioned.
 */
export async function postProjectMessage(
  tenantId: TenantId,
  authorId: string,
  projectId: string,
  rawBody: string | null | undefined
): Promise<{ id: string; mentioned: number; everyone: number }> {
  const body = normalizeMessage(rawBody);
  if (!UUID.test(projectId)) throw new ChatError('That project is not in this workspace.');
  return tx(async (client) => {
    const { rowCount: member } = await client.query(
      `select 1 from memberships where tenant_id = $1 and user_id = $2`,
      [tenantId, authorId]
    );
    if (!member) throw new ChatError('You are not a member of this workspace.');
    const {
      rows: [project],
    } = await client.query<{ name: string }>(
      `select name from projects where tenant_id = $1 and id = $2`,
      [tenantId, projectId]
    );
    if (!project) throw new ChatError('That project is not in this workspace.');
    const {
      rows: [message],
    } = await client.query<{ id: string }>(
      `insert into project_messages (tenant_id, project_id, author_id, body)
       values ($1, $2, $3, $4) returning id`,
      [tenantId, projectId, authorId, body]
    );
    if (!message) throw new Error('project_messages insert returned no row');
    const mentioned = await notifyMentions(client, tenantId, {
      body,
      actorId: authorId,
      payload: { chatProjectId: projectId, title: `${project.name} conversation` },
    });
    return {
      id: message.id,
      mentioned: mentioned.direct.length,
      everyone: mentioned.everyone.length,
    };
  });
}
