/**
 * PM sign-off write-back against a real Postgres and a stubbed Jira, plus the rule that
 * no worker module can reach the write grant.
 *
 * The DB suite is skipped without SPECFIX_TEST_DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  addJiraProject,
  addMembership,
  closePool,
  createTenant,
  currentWritebacks,
  decideFlag,
  ingestTicket,
  query,
  recordAnalysis,
  saveJiraGrant,
  setJiraSite,
} from '@specfix/db';
import { JiraClient, signOffComment } from '@specfix/ingest';
import { writeBackSignOff, type WritebackDeps } from '../src/index.ts';

const hasDatabase = Boolean(process.env.SPECFIX_TEST_DATABASE_URL);
const srcDir = fileURLToPath(new URL('../src/', import.meta.url));

afterAll(async () => {
  if (hasDatabase) await closePool();
});

describe('write grant isolation', () => {
  it('no worker module imports the write-back code', async () => {
    const files = (await readdir(srcDir)).filter(
      (f) => f.endsWith('.ts') && f !== 'writeback.ts' && f !== 'index.ts'
    );
    for (const file of files) {
      const source = await readFile(join(srcDir, file), 'utf8');
      expect(source, file).not.toMatch(/from '\.\/writeback\.ts'/);
      expect(source, file).not.toMatch(/getJiraAccess\([^)]*'write'/);
    }
  });
});

describe('signOffComment', () => {
  it('lists the criteria and clarifications as plain text nodes', () => {
    const doc = signOffComment({
      acceptanceCriteria: '- Max 99\n- Show an error',
      clarifications: [
        { question: 'Does the limit apply to edits?', answer: 'Yes, every change.' },
      ],
      reviewUrl: 'https://specfix.example.com/tickets/1',
    });
    const json = JSON.stringify(doc);
    expect(json).toContain('"text":"Max 99"');
    expect(json).toContain('Does the limit apply to edits?');
    expect(json).toContain(' — Yes, every change.');
    expect(json).toContain('https://specfix.example.com/tickets/1');
  });
});

describe.skipIf(!hasDatabase)('writeBackSignOff', () => {
  const label = `wb-${Date.now()}`;
  let tenantId: string;
  let userId: string;
  let ticketId: string;
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  let failNext = false;

  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname.replace(/^.*\/rest\/api\/3/, '');
    calls.push({
      method: init?.method ?? 'GET',
      path,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    if (failNext) {
      failNext = false;
      return new Response(JSON.stringify({ errorMessages: ['Issue is locked'] }), { status: 400 });
    }
    if (path.endsWith('/comment'))
      return new Response(JSON.stringify({ id: '9001' }), { status: 201 });
    return new Response(null, { status: 204 });
  }) as typeof fetch;

  const deps: WritebackDeps = {
    writeClient: async (_t, cloudId) =>
      new JiraClient({ cloudId, getAccessToken: async () => 'w', fetch: fetchImpl }),
    reviewUrl: () => null,
  };
  const grant = (scope: string) => ({
    accessToken: 'a',
    refreshToken: 'r',
    expiresAt: new Date(Date.now() + 3600_000),
    scopes: [scope],
  });

  beforeAll(async () => {
    process.env.TOKEN_ENCRYPTION_KEY ||= randomBytes(32).toString('base64');
    tenantId = (await createTenant(label)).id;
    const [user] = await query<{ id: string }>(
      `insert into auth.users (email) values ($1) returning id`,
      [`${label}@example.test`]
    );
    userId = user!.id;
    await addMembership(tenantId, userId, 'owner');
    await saveJiraGrant(tenantId, userId, 'read', grant('read:jira-work'));
    await setJiraSite(tenantId, userId, {
      cloudId: 'cloud-wb',
      siteUrl: 'https://wb.atlassian.net',
      siteName: 'WB',
    });
    const project = await addJiraProject(tenantId, userId, { projectKey: 'CART', name: 'Cart' });

    const ingested = await ingestTicket(tenantId, project.id, {
      externalId: '777',
      externalKey: 'CART-7',
      title: 'Limit cart quantity',
      descriptionText: 'Users should not add too many items.',
      acceptanceCriteriaText: '- Maximum quantity per item is 99',
      raw: null,
      sourceUpdatedAt: null,
    });
    ticketId = ingested.ticket.id;
    const recorded = await recordAnalysis(tenantId, {
      ticketId,
      ticketVersionId: ingested.version.id,
      meta: {
        promptVersion: 'test',
        model: 'gpt-5.4-mini',
        temperature: 1,
        seed: null,
        truncated: false,
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0,
      },
      flags: [
        {
          category: 'edge_case',
          quoted_span: '',
          what_unclear: 'Edits',
          why_it_matters: 'x',
          question_for_pm: 'Does the limit apply to edits?',
          severity: 'medium',
          dedupeKey: 'a',
        },
        {
          category: 'vague_language',
          quoted_span: '',
          what_unclear: 'Noise',
          why_it_matters: 'x',
          question_for_pm: 'Is this noise?',
          severity: 'low',
          dedupeKey: 'b',
        },
      ],
      calls: [],
    });
    await decideFlag(tenantId, {
      flagId: recorded.flagIds[0]!,
      userId,
      decision: 'accepted',
      resolutionNote: 'Yes, every change.',
    });
    await decideFlag(tenantId, { flagId: recorded.flagIds[1]!, userId, decision: 'dismissed' });
  });

  it('does nothing until write-back is enabled', async () => {
    expect(await writeBackSignOff(tenantId, { ticketId, userId }, deps)).toEqual({
      status: 'skipped',
      reason: 'Jira write-back is not enabled',
    });
    expect(calls).toHaveLength(0);
  });

  it('writes a comment with accepted clarifications and a label', async () => {
    await saveJiraGrant(tenantId, userId, 'write', grant('write:jira-work'));
    expect(await writeBackSignOff(tenantId, { ticketId, userId }, deps)).toEqual({
      status: 'written',
      commentId: '9001',
    });
    const comment = calls.find((c) => c.path === '/issue/777/comment')!;
    const body = JSON.stringify(comment.body);
    expect(body).toContain('Maximum quantity per item is 99');
    expect(body).toContain('Does the limit apply to edits?');
    expect(body).toContain('Yes, every change.');
    expect(body).not.toContain('Is this noise?');
    const label = calls.find((c) => c.method === 'PUT')!;
    expect(label.body).toEqual({ update: { labels: [{ add: 'specfix-ready' }] } });
    expect((await currentWritebacks(tenantId, ticketId)).map((r) => r.status)).toEqual([
      'done',
      'done',
    ]);
  });

  it('never writes the same version twice', async () => {
    const before = calls.length;
    await writeBackSignOff(tenantId, { ticketId, userId }, deps);
    expect(calls.length).toBe(before);
  });

  it('records a failure and lets a retry finish only what failed', async () => {
    await query(`delete from jira_writebacks where tenant_id = $1 and kind = 'label'`, [tenantId]);
    failNext = true;
    const failed = await writeBackSignOff(tenantId, { ticketId, userId }, deps);
    expect(failed.status).toBe('failed');
    expect(
      (await currentWritebacks(tenantId, ticketId)).find((r) => r.kind === 'label')?.status
    ).toBe('failed');

    const before = calls.length;
    expect((await writeBackSignOff(tenantId, { ticketId, userId }, deps)).status).toBe('written');
    const retried = calls.slice(before);
    expect(retried.map((c) => c.method)).toEqual(['PUT']);
  });
});
