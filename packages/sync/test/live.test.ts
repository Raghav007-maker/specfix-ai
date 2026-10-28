/**
 * Live Jira sync against a real Postgres and a stubbed Jira: single-issue sync,
 * archiving, reconcile, webhook registration and the scheduler.
 *
 * Skipped without SPECFIX_TEST_DATABASE_URL, like the other fixture-writing suites.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  addJiraProject,
  addMembership,
  closePool,
  createTenant,
  enqueueJob,
  getTenantWebhook,
  query,
  saveJiraGrant,
  setJiraSite,
  type JobRow,
} from '@specfix/db';
import { JiraClient, type JiraIssue } from '@specfix/ingest';
import {
  runIssueSync,
  runReconcile,
  runWebhookSync,
  scheduleDueJobs,
  type LiveDeps,
} from '../src/index.ts';

const hasDatabase = Boolean(process.env.SPECFIX_TEST_DATABASE_URL);

afterAll(async () => {
  if (hasDatabase) await closePool();
});

function issue(id: number, project: string, body = `Body ${id}`): JiraIssue {
  return {
    id: String(id),
    key: `${project}-${id}`,
    fields: {
      project: { key: project },
      summary: `Story ${id}`,
      updated: new Date().toISOString(),
      issuetype: { name: 'Story' },
      status: { name: 'To Do', statusCategory: { key: 'new' } },
      description: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: body }] }],
      },
    },
  };
}

/** A tiny fake of the Jira endpoints live sync touches. */
function fakeJira() {
  const issues = new Map<string, JiraIssue>();
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  let nextWebhookId = 500;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname.replace(/^.*\/rest\/api\/3/, '');
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method, path, body });
    const json = (status: number, value: unknown) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { 'content-type': 'application/json' },
      });

    const one = /^\/issue\/(\d+)$/.exec(path);
    if (one) {
      const found = issues.get(one[1]!);
      return found ? json(200, found) : json(404, { errorMessages: ['Issue does not exist'] });
    }
    if (path === '/search/jql') return json(200, { issues: [...issues.values()], isLast: true });
    if (path === '/webhook' && method === 'POST') {
      return json(200, { webhookRegistrationResult: [{ createdWebhookId: nextWebhookId++ }] });
    }
    if (path === '/webhook/refresh') {
      return json(200, { expirationDate: new Date(Date.now() + 30 * 86_400_000).toISOString() });
    }
    if (path === '/webhook' && method === 'DELETE') return new Response(null, { status: 202 });
    return json(404, {});
  }) as typeof fetch;
  const client = new JiraClient({
    cloudId: 'cloud-live',
    getAccessToken: async () => 't',
    fetch: fetchImpl,
  });
  return { issues, calls, client };
}

describe.skipIf(!hasDatabase)('jira live sync', () => {
  const label = `live-${Date.now()}`;
  let tenantId: string;
  let adminId: string;
  const jira = fakeJira();
  const newVersions: string[] = [];
  const deps = (over: Partial<LiveDeps> = {}): LiveDeps => ({
    clientFor: async () => ({ client: jira.client, cloudId: 'cloud-live' }),
    onNewVersion: async (_t, ticketId) => void newVersions.push(ticketId),
    publicBaseUrl: 'https://specfix.example.com',
    ...over,
  });
  const job = (kind: JobRow['kind'], payload: Record<string, unknown> = {}): JobRow =>
    ({
      id: '00000000-0000-0000-0000-000000000000',
      tenant_id: tenantId,
      project_id: null,
      kind,
      payload,
      progress: {},
    }) as JobRow;

  beforeAll(async () => {
    process.env.TOKEN_ENCRYPTION_KEY ||= randomBytes(32).toString('base64');
    tenantId = (await createTenant(label)).id;
    const [user] = await query<{ id: string }>(
      `insert into auth.users (email) values ($1) returning id`,
      [`${label}@example.test`]
    );
    adminId = user!.id;
    await addMembership(tenantId, adminId, 'owner');
    await saveJiraGrant(tenantId, adminId, 'read', {
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: new Date(Date.now() + 3600_000),
      scopes: ['read:jira-work'],
    });
    await setJiraSite(tenantId, adminId, {
      cloudId: 'cloud-live',
      siteUrl: 'https://live.atlassian.net',
      siteName: 'Live',
    });
    await addJiraProject(tenantId, adminId, { projectKey: 'CART', name: 'Cart' });
  });

  beforeEach(() => {
    newVersions.length = 0;
  });

  const ticketRow = async (externalId: string) =>
    (
      await query<{ title: string; archived_at: Date | null }>(
        `select title, archived_at from tickets where tenant_id = $1 and external_id = $2`,
        [tenantId, externalId]
      )
    )[0];

  it('creates a ticket from a webhook signal and reports the new version', async () => {
    jira.issues.set('101', issue(101, 'CART'));
    expect(await runIssueSync(job('jira_issue_sync', { issueId: '101' }), deps())).toEqual({
      outcome: 'new',
    });
    expect((await ticketRow('101'))?.title).toBe('Story 101');
    expect(newVersions).toHaveLength(1);
  });

  it('does nothing for a delivery that changed no text', async () => {
    expect(await runIssueSync(job('jira_issue_sync', { issueId: '101' }), deps())).toEqual({
      outcome: 'unchanged',
    });
    expect(newVersions).toHaveLength(0);
  });

  it('archives an issue deleted in Jira, and revives it if it comes back', async () => {
    jira.issues.delete('101');
    expect(await runIssueSync(job('jira_issue_sync', { issueId: '101' }), deps())).toEqual({
      outcome: 'archived',
    });
    expect((await ticketRow('101'))?.archived_at).not.toBeNull();

    jira.issues.set('101', issue(101, 'CART'));
    await runIssueSync(job('jira_issue_sync', { issueId: '101' }), deps());
    expect((await ticketRow('101'))?.archived_at).toBeNull();
  });

  it('archives an issue moved to a project SpecFix does not sync', async () => {
    jira.issues.set('101', issue(101, 'OTHER'));
    expect(await runIssueSync(job('jira_issue_sync', { issueId: '101' }), deps())).toEqual({
      outcome: 'archived',
    });
    jira.issues.set('101', issue(101, 'CART'));
  });

  it('reconcile picks up changes that no webhook announced', async () => {
    jira.issues.set('102', issue(102, 'CART'));
    jira.issues.set('101', issue(101, 'CART', 'Edited in Jira'));
    const progress = await runReconcile(job('jira_reconcile'), deps());
    expect(progress.newVersions).toBe(2);
    const search = jira.calls.filter((c) => c.path === '/search/jql').at(-1)!;
    expect((search.body as { jql: string }).jql).toMatch(
      /^project IN \("CART"\) AND updated >= -\d+m/
    );
  });

  it('registers one webhook, refreshes nothing while it is fresh, re-registers when projects change', async () => {
    expect(await runWebhookSync(job('jira_webhook_sync'), deps({ publicBaseUrl: null }))).toEqual({
      action: 'skipped',
    });

    expect(await runWebhookSync(job('jira_webhook_sync'), deps())).toEqual({
      action: 'registered',
    });
    const first = await getTenantWebhook(tenantId);
    expect(first?.jql).toBe('project IN ("CART")');
    expect(first?.url).toMatch(
      /^https:\/\/specfix\.example\.com\/api\/jira\/webhook\/[0-9a-f-]{36}$/
    );

    expect(await runWebhookSync(job('jira_webhook_sync'), deps())).toEqual({ action: 'unchanged' });

    await query(
      `update jira_webhooks set expires_at = now() + interval '1 day' where tenant_id = $1`,
      [tenantId]
    );
    expect(await runWebhookSync(job('jira_webhook_sync'), deps())).toEqual({ action: 'refreshed' });

    await addJiraProject(tenantId, adminId, { projectKey: 'PAY', name: 'Payments' });
    expect(await runWebhookSync(job('jira_webhook_sync'), deps())).toEqual({
      action: 'registered',
    });
    expect((await getTenantWebhook(tenantId))?.jql).toBe('project IN ("CART", "PAY")');
    expect(jira.calls.some((c) => c.method === 'DELETE' && c.path === '/webhook')).toBe(true);
  });

  it('the scheduler queues each due reconcile once', async () => {
    await query(`update sync_jobs set status = 'done' where status in ('queued', 'running')`);
    await query(`update jira_connections set last_reconciled_at = null where tenant_id = $1`, [
      tenantId,
    ]);
    const env = { JIRA_RECONCILE_MINUTES: '5' };
    expect(await scheduleDueJobs(env)).toBeGreaterThanOrEqual(1);
    const again = await scheduleDueJobs(env);
    const pending = await query(
      `select 1 from sync_jobs where tenant_id = $1 and kind = 'jira_reconcile' and status = 'queued'`,
      [tenantId]
    );
    expect(pending).toHaveLength(1);
    expect(again).toBe(0);
    await enqueueJob(tenantId, { kind: 'jira_reconcile', dedupeKey: `reconcile:${tenantId}` }).then(
      (j) => expect(j).toBeNull()
    );
  });
});
