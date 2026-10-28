/**
 * Jira connections: who may connect, how tokens are stored, and refresh under rotation.
 *
 * Skipped without SPECFIX_TEST_DATABASE_URL, like the other fixture-writing suites.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  JiraConnectionError,
  addJiraProject,
  addMembership,
  closePool,
  createTenant,
  disconnectJira,
  getJiraAccess,
  getJiraConnection,
  listProjects,
  markJiraConnectionError,
  query,
  saveJiraGrant,
  setJiraSite,
  type JiraTokenSet,
} from '../src/index.ts';

const hasDatabase = Boolean(process.env.SPECFIX_TEST_DATABASE_URL);

afterAll(async () => {
  if (hasDatabase) await closePool();
});

function tokens(n: number, expiresInMs = 3600_000): JiraTokenSet {
  return {
    accessToken: `access-${n}`,
    refreshToken: `refresh-${n}`,
    expiresAt: new Date(Date.now() + expiresInMs),
    scopes: ['read:jira-work', 'offline_access'],
  };
}

describe.skipIf(!hasDatabase)('jira connections', () => {
  const label = `jira-${Date.now()}`;
  let tenantId: string;
  let otherTenantId: string;
  const users = {} as Record<'owner' | 'admin' | 'reviewer', string>;

  beforeAll(async () => {
    process.env.TOKEN_ENCRYPTION_KEY ||= randomBytes(32).toString('base64');
    tenantId = (await createTenant(label)).id;
    otherTenantId = (await createTenant(`${label}-other`)).id;
    for (const role of ['owner', 'admin', 'reviewer'] as const) {
      const [user] = await query<{ id: string }>(
        `insert into auth.users (email) values ($1) returning id`,
        [`${label}-${role}@example.test`]
      );
      users[role] = user!.id;
      await addMembership(tenantId, user!.id, role);
    }
  });

  it('refuses a reviewer', async () => {
    await expect(saveJiraGrant(tenantId, users.reviewer, 'read', tokens(0))).rejects.toThrow(
      JiraConnectionError
    );
    expect(await getJiraConnection(tenantId)).toBeNull();
  });

  it('stores tokens encrypted, never in plaintext', async () => {
    await saveJiraGrant(tenantId, users.admin, 'read', tokens(1));
    const [raw] = await query<{ access_token_enc: Buffer; refresh_token_enc: Buffer }>(
      `select access_token_enc, refresh_token_enc from jira_connections where tenant_id = $1`,
      [tenantId]
    );
    expect(raw!.access_token_enc.toString('latin1')).not.toContain('access-1');
    expect(raw!.refresh_token_enc.toString('latin1')).not.toContain('refresh-1');

    const connection = await getJiraConnection(tenantId);
    expect(connection).toMatchObject({ grant_kind: 'read', status: 'active', cloud_id: null });
    expect(connection!.connected_by_email).toBe(`${label}-admin@example.test`);
    expect(Object.keys(connection!)).not.toContain('access_token_enc');
  });

  it('hands out the stored token without refreshing while it is fresh', async () => {
    let refreshes = 0;
    const grant = await getJiraAccess(tenantId, 'read', async () => {
      refreshes++;
      return tokens(99);
    });
    expect(grant.accessToken).toBe('access-1');
    expect(refreshes).toBe(0);
  });

  it('refreshes an expiring token once, even when asked concurrently, and keeps the rotated one', async () => {
    await saveJiraGrant(tenantId, users.admin, 'read', tokens(2, 10_000));
    const seen: string[] = [];
    const refresh = async (refreshToken: string) => {
      seen.push(refreshToken);
      await new Promise((resolve) => setTimeout(resolve, 50));
      return tokens(3);
    };
    const grants = await Promise.all([
      getJiraAccess(tenantId, 'read', refresh),
      getJiraAccess(tenantId, 'read', refresh),
      getJiraAccess(tenantId, 'read', refresh),
    ]);
    expect(seen).toEqual(['refresh-2']);
    expect(grants.map((g) => g.accessToken)).toEqual(['access-3', 'access-3', 'access-3']);

    // The next refresh must present the rotated token, not the original.
    await query(
      `update jira_connections set expires_at = now() where tenant_id = $1 and grant_kind = 'read'`,
      [tenantId]
    );
    await getJiraAccess(tenantId, 'read', async (refreshToken) => {
      seen.push(refreshToken);
      return tokens(4);
    });
    expect(seen).toEqual(['refresh-2', 'refresh-3']);
  });

  it('records a broken grant and clears it on reconnect', async () => {
    await markJiraConnectionError(tenantId, 'read', 'invalid_grant');
    expect(await getJiraConnection(tenantId)).toMatchObject({
      status: 'error',
      last_error: 'invalid_grant',
    });
    await saveJiraGrant(tenantId, users.owner, 'read', tokens(5));
    expect(await getJiraConnection(tenantId)).toMatchObject({ status: 'active', last_error: null });
  });

  it('needs a site before projects, and adds each Jira project once', async () => {
    await expect(
      addJiraProject(tenantId, users.admin, { projectKey: 'CART', name: 'Cart' })
    ).rejects.toThrow(/choose a site/i);

    await setJiraSite(tenantId, users.admin, {
      cloudId: 'cloud-a',
      siteUrl: 'https://acme.atlassian.net',
      siteName: 'Acme',
    });
    const project = await addJiraProject(tenantId, users.admin, {
      projectKey: 'CART',
      name: 'Cart',
      acFieldId: 'customfield_10042',
    });
    expect(project).toMatchObject({
      source_type: 'jira',
      jira_cloud_id: 'cloud-a',
      jira_project_key: 'CART',
    });
    await expect(
      addJiraProject(tenantId, users.admin, { projectKey: 'CART', name: 'Cart' })
    ).rejects.toThrow(/already in this workspace/);
    await expect(
      addJiraProject(tenantId, users.reviewer, { projectKey: 'PAY', name: 'Payments' })
    ).rejects.toThrow(JiraConnectionError);
  });

  it('refuses to switch sites while projects from the current one remain', async () => {
    await expect(
      setJiraSite(tenantId, users.admin, {
        cloudId: 'cloud-b',
        siteUrl: 'https://other.atlassian.net',
        siteName: 'Other',
      })
    ).rejects.toThrow(/Remove the Jira projects/);
  });

  it('keeps tenants apart', async () => {
    expect(await getJiraConnection(otherTenantId)).toBeNull();
    await expect(getJiraAccess(otherTenantId, 'read', async () => tokens(0))).rejects.toThrow(
      /not connected/
    );
  });

  it('refuses a ciphertext copied into another tenant', async () => {
    const [user] = await query<{ id: string }>(
      `insert into auth.users (email) values ($1) returning id`,
      [`${label}-other-owner@example.test`]
    );
    await addMembership(otherTenantId, user!.id, 'owner');
    await saveJiraGrant(otherTenantId, user!.id, 'read', tokens(7));
    await query(
      `update jira_connections dst
       set access_token_enc = src.access_token_enc
       from jira_connections src
       where src.tenant_id = $1 and dst.tenant_id = $2
         and src.grant_kind = 'read' and dst.grant_kind = 'read'`,
      [tenantId, otherTenantId]
    );
    await expect(getJiraAccess(otherTenantId, 'read', async () => tokens(0))).rejects.toThrow();
  });

  it('disconnect deletes the grant but keeps the projects', async () => {
    await expect(disconnectJira(tenantId, users.reviewer)).rejects.toThrow(JiraConnectionError);
    await disconnectJira(tenantId, users.owner);
    expect(await getJiraConnection(tenantId)).toBeNull();
    const projects = await listProjects(tenantId);
    expect(projects.map((p) => p.jira_project_key)).toContain('CART');
  });
});
