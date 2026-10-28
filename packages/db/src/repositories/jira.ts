/**
 * Jira Cloud connections: the stored OAuth grant, the site the tenant works in, and
 * the Jira projects added to the workspace.
 *
 * The rules this module carries:
 *
 *   - Only an owner or admin connects, changes or disconnects Jira, and adds Jira
 *     projects. The role is re-read inside the writing transaction, so a stale page
 *     or a hand-built request cannot act with a role the user no longer holds.
 *   - Tokens are encrypted here and decrypted here (../crypto.ts). Callers never see
 *     ciphertext, and only getJiraAccess hands out a plaintext access token.
 *   - Refresh is serialized per grant. Atlassian rotates refresh tokens, so two
 *     concurrent refreshes with the same token would leave one of them holding a
 *     dead token. getJiraAccess takes the row lock, re-checks expiry, and only then
 *     calls the refresher it was given — this package stays free of HTTP.
 */
import type { PoolClient } from 'pg';
import { tx, query, type TenantId } from '../client.ts';
import { decryptSecret, encryptSecret, tokenKeyId } from '../crypto.ts';
import type { ProjectRow } from './tenants.ts';

export const JIRA_GRANT_KINDS = ['read', 'write'] as const;
export type JiraGrantKind = (typeof JIRA_GRANT_KINDS)[number];

export class JiraConnectionError extends Error {}

export interface JiraTokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  scopes: string[];
}

/** A connection as the app may display it: everything except the tokens. */
export interface JiraConnectionRow {
  id: string;
  grant_kind: JiraGrantKind;
  scopes: string[];
  expires_at: Date;
  cloud_id: string | null;
  site_url: string | null;
  site_name: string | null;
  status: 'active' | 'error';
  last_error: string | null;
  connected_by_email: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface JiraGrant {
  accessToken: string;
  cloudId: string | null;
  siteUrl: string | null;
}

/** Refresh this many seconds before expiry, so a token never dies mid-request. */
const REFRESH_SKEW_MS = 60_000;

function context(tenantId: TenantId, kind: JiraGrantKind, which: 'access' | 'refresh'): string {
  return `jira:${tenantId}:${kind}:${which}`;
}

/** Throws unless `userId` is an owner or admin of the tenant; holds their membership row. */
export async function requireTenantAdmin(client: PoolClient, tenantId: TenantId, userId: string) {
  const result = await client.query<{ role: string }>(
    `select role from memberships where tenant_id = $1 and user_id = $2 for share`,
    [tenantId, userId]
  );
  const role = result.rows[0]?.role;
  if (role !== 'owner' && role !== 'admin') {
    throw new JiraConnectionError('Only an owner or admin can manage the Jira connection.');
  }
}

/**
 * Stores a freshly consented grant, replacing any previous grant of the same kind.
 * The chosen site is kept on reconnect: the integrations page re-checks it against
 * the sites the new grant can reach.
 */
export async function saveJiraGrant(
  tenantId: TenantId,
  actorId: string,
  kind: JiraGrantKind,
  tokens: JiraTokenSet
): Promise<void> {
  await tx(async (client) => {
    await requireTenantAdmin(client, tenantId, actorId);
    await client.query(
      `insert into jira_connections
         (tenant_id, grant_kind, scopes, access_token_enc, refresh_token_enc, key_id,
          expires_at, connected_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (tenant_id, grant_kind) do update set
         scopes = excluded.scopes,
         access_token_enc = excluded.access_token_enc,
         refresh_token_enc = excluded.refresh_token_enc,
         key_id = excluded.key_id,
         expires_at = excluded.expires_at,
         connected_by = excluded.connected_by,
         status = 'active',
         last_error = null,
         updated_at = now()`,
      [
        tenantId,
        kind,
        tokens.scopes,
        encryptSecret(tokens.accessToken, context(tenantId, kind, 'access')),
        encryptSecret(tokens.refreshToken, context(tenantId, kind, 'refresh')),
        tokenKeyId(),
        tokens.expiresAt,
        actorId,
      ]
    );
  });
}

export async function getJiraConnection(
  tenantId: TenantId,
  kind: JiraGrantKind = 'read'
): Promise<JiraConnectionRow | null> {
  const [row] = await query<JiraConnectionRow>(
    `select c.id, c.grant_kind, c.scopes, c.expires_at, c.cloud_id, c.site_url, c.site_name,
            c.status, c.last_error, u.email as connected_by_email, c.created_at, c.updated_at
     from jira_connections c
     left join auth.users u on u.id = c.connected_by
     where c.tenant_id = $1 and c.grant_kind = $2`,
    [tenantId, kind]
  );
  return row ?? null;
}

/**
 * Chooses the Jira site the workspace syncs from. Switching to a different site is
 * refused while Jira projects from the current one are still in the workspace —
 * their tickets would otherwise point at a site the grant no longer serves.
 */
export async function setJiraSite(
  tenantId: TenantId,
  actorId: string,
  site: { cloudId: string; siteUrl: string; siteName: string }
): Promise<void> {
  await tx(async (client) => {
    await requireTenantAdmin(client, tenantId, actorId);
    const current = await client.query<{ cloud_id: string | null }>(
      `select cloud_id from jira_connections
       where tenant_id = $1 and grant_kind = 'read' for update`,
      [tenantId]
    );
    const row = current.rows[0];
    if (!row) throw new JiraConnectionError('Connect Jira before choosing a site.');
    if (row.cloud_id && row.cloud_id !== site.cloudId) {
      const linked = await client.query(
        `select 1 from projects
         where tenant_id = $1 and source_type = 'jira' and jira_cloud_id = $2 limit 1`,
        [tenantId, row.cloud_id]
      );
      if (linked.rowCount) {
        throw new JiraConnectionError(
          'Remove the Jira projects from the current site before switching to another.'
        );
      }
    }
    await client.query(
      `update jira_connections
       set cloud_id = $2, site_url = $3, site_name = $4, updated_at = now()
       where tenant_id = $1 and grant_kind = 'read'`,
      [tenantId, site.cloudId, site.siteUrl, site.siteName]
    );
  });
}

/**
 * A usable access token for the grant, refreshed first if it is about to expire.
 * `refresh` exchanges a refresh token for a new token set; it runs while the grant's
 * row is locked, and only when the token still needs refreshing once the lock is held.
 */
export async function getJiraAccess(
  tenantId: TenantId,
  kind: JiraGrantKind,
  refresh: (refreshToken: string) => Promise<JiraTokenSet>
): Promise<JiraGrant> {
  const [row] = await query<StoredGrant>(STORED_GRANT_SQL, [tenantId, kind]);
  if (!row) throw new JiraConnectionError('Jira is not connected.');
  if (!expiring(row)) return toGrant(tenantId, kind, row);

  return tx(async (client) => {
    const locked = await client.query<StoredGrant>(`${STORED_GRANT_SQL} for update`, [
      tenantId,
      kind,
    ]);
    const current = locked.rows[0];
    if (!current) throw new JiraConnectionError('Jira is not connected.');
    if (!expiring(current)) return toGrant(tenantId, kind, current);

    const next = await refresh(
      decryptSecret(current.refresh_token_enc, context(tenantId, kind, 'refresh'), current.key_id)
    );
    await client.query(
      `update jira_connections
       set access_token_enc = $3, refresh_token_enc = $4, key_id = $5, expires_at = $6,
           scopes = $7, status = 'active', last_error = null, updated_at = now()
       where tenant_id = $1 and grant_kind = $2`,
      [
        tenantId,
        kind,
        encryptSecret(next.accessToken, context(tenantId, kind, 'access')),
        encryptSecret(next.refreshToken, context(tenantId, kind, 'refresh')),
        tokenKeyId(),
        next.expiresAt,
        next.scopes,
      ]
    );
    return { accessToken: next.accessToken, cloudId: current.cloud_id, siteUrl: current.site_url };
  });
}

/** Records that the grant stopped working (e.g. consent revoked in Atlassian). */
export async function markJiraConnectionError(
  tenantId: TenantId,
  kind: JiraGrantKind,
  message: string
): Promise<void> {
  await query(
    `update jira_connections set status = 'error', last_error = $3, updated_at = now()
     where tenant_id = $1 and grant_kind = $2`,
    [tenantId, kind, message.slice(0, 500)]
  );
}

/**
 * Deletes every stored grant for the tenant. Jira projects stay in the workspace
 * with their tickets; they simply stop syncing until Jira is connected again.
 */
export async function disconnectJira(tenantId: TenantId, actorId: string): Promise<void> {
  await tx(async (client) => {
    await requireTenantAdmin(client, tenantId, actorId);
    await client.query(`delete from jira_connections where tenant_id = $1`, [tenantId]);
  });
}

/** Adds a Jira project from the connected site to the workspace. */
export async function addJiraProject(
  tenantId: TenantId,
  actorId: string,
  input: { projectKey: string; name: string; acFieldId?: string | null }
): Promise<ProjectRow> {
  return tx(async (client) => {
    await requireTenantAdmin(client, tenantId, actorId);
    const connection = await client.query<{ id: string; cloud_id: string | null }>(
      `select id, cloud_id from jira_connections where tenant_id = $1 and grant_kind = 'read'`,
      [tenantId]
    );
    const row = connection.rows[0];
    if (!row?.cloud_id) throw new JiraConnectionError('Connect Jira and choose a site first.');

    const inserted = await client.query<ProjectRow>(
      `insert into projects
         (tenant_id, name, source_type, jira_cloud_id, jira_project_key, jira_connection_id,
          ac_field_id)
       values ($1, $2, 'jira', $3, $4, $5, $6)
       on conflict (tenant_id, jira_cloud_id, jira_project_key) where source_type = 'jira'
       do nothing
       returning id, tenant_id, name, source_type, jira_cloud_id, jira_project_key`,
      [tenantId, input.name, row.cloud_id, input.projectKey, row.id, input.acFieldId || null]
    );
    const project = inserted.rows[0];
    if (!project) {
      throw new JiraConnectionError(`${input.projectKey} is already in this workspace.`);
    }
    return project;
  });
}

interface StoredGrant {
  access_token_enc: Buffer;
  refresh_token_enc: Buffer;
  key_id: string;
  expires_at: Date;
  cloud_id: string | null;
  site_url: string | null;
}

const STORED_GRANT_SQL = `select access_token_enc, refresh_token_enc, key_id, expires_at,
                                 cloud_id, site_url
                          from jira_connections where tenant_id = $1 and grant_kind = $2`;

function expiring(row: StoredGrant): boolean {
  return row.expires_at.getTime() - Date.now() < REFRESH_SKEW_MS;
}

function toGrant(tenantId: TenantId, kind: JiraGrantKind, row: StoredGrant): JiraGrant {
  return {
    accessToken: decryptSecret(row.access_token_enc, context(tenantId, kind, 'access'), row.key_id),
    cloudId: row.cloud_id,
    siteUrl: row.site_url,
  };
}
