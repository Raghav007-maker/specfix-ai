/**
 * Cross-tenant isolation.
 *
 * The header comment on 0001_init.sql says RLS is not the isolation mechanism,
 * because the worker connects with the service-role key and bypasses it. This file is
 * what makes that claim more than a comment: it drives every repository function with
 * one tenant's id and another tenant's row ids, and asserts nothing leaks.
 *
 * Two things are checked, and the second is the one people forget:
 *  - reads scoped to a tenant do not return another tenant's rows
 *  - writes addressed to another tenant's row id fail rather than succeed against it
 *
 * A read that returns zero rows is easy to get right by accident. A write that
 * silently succeeds cross-tenant is a data-integrity incident, so `decideFlag`,
 * `linkGap`, and friends are exercised too.
 *
 * Skipped without DATABASE_URL. In CI a postgres:16 service provides one, so this
 * does run on every push — a skipped isolation test is how a cross-tenant read ships.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  closePool,
  query,
  createTenant,
  createProject,
  addMembership,
  ingestTicket,
  listTicketsForProject,
  recordAnalysis,
  listRunsForTicket,
  monthlyTokenUsage,
  listFlagsForVersion,
  listOpenFlagsForTicket,
  decideFlag,
  listDecisionsForFlag,
  startSession,
  addGap,
  lockGaps,
  flagsForReveal,
  linkGap,
  listGaps,
  markReady,
  listReadinessEvents,
  timeToReady,
} from '../src/index.ts';
import type { NormalizedTicket } from '@specfix/shared';

const hasDatabase = Boolean(process.env.DATABASE_URL);

function ticket(key: string, title: string): NormalizedTicket {
  return {
    externalId: key,
    externalKey: key,
    title,
    descriptionText: `Description for ${key}.`,
    acceptanceCriteriaText: `- ${key} works`,
    raw: { key },
    sourceUpdatedAt: null,
  };
}

interface World {
  tenantId: string;
  userId: string;
  projectId: string;
  ticketId: string;
  ticketVersionId: string;
  flagId: string;
  sessionId: string;
  gapId: string;
}

async function makeWorld(label: string): Promise<World> {
  const tenant = await createTenant(`tenant-${label}`);
  const [user] = await query<{ id: string }>(
    `insert into auth.users (email) values ($1) returning id`,
    [`${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`]
  );
  if (!user) throw new Error('could not create test user');

  await addMembership(tenant.id, user.id, 'owner');
  const project = await createProject(tenant.id, { name: `project-${label}`, sourceType: 'file' });
  const ingested = await ingestTicket(
    tenant.id,
    project.id,
    ticket(`${label}-1`, `Ticket ${label}`)
  );

  const analysis = await recordAnalysis(tenant.id, {
    ticketId: ingested.ticket.id,
    ticketVersionId: ingested.version.id,
    meta: {
      promptVersion: 'single-shot-v1@000000000000',
      model: 'gpt-4o-mini',
      temperature: 0,
      seed: 1337,
      truncated: false,
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.0001,
    },
    flags: [
      {
        category: 'missing_info',
        quoted_span: '',
        what_unclear: `unclear thing for ${label}`,
        why_it_matters: 'it matters',
        question_for_pm: 'which one?',
        severity: 'high',
        dedupeKey: `missing_info:unclear-thing-for-${label}`,
      },
    ],
    calls: [
      {
        purpose: 'single_shot',
        promptVersion: 'single-shot-v1@000000000000',
        model: 'gpt-4o-mini',
        request: { messages: [] },
        response: { flags: [] },
        latencyMs: 10,
        inputTokens: 100,
        outputTokens: 50,
        costUsd: 0.0001,
      },
    ],
  });

  const flagId = analysis.flagIds[0];
  if (!flagId) throw new Error('expected a flag to be inserted');

  const session = await startSession(tenant.id, ingested.version.id, user.id);
  const gap = await addGap(tenant.id, session.id, `gap noted by ${label}`);

  return {
    tenantId: tenant.id,
    userId: user.id,
    projectId: project.id,
    ticketId: ingested.ticket.id,
    ticketVersionId: ingested.version.id,
    flagId,
    sessionId: session.id,
    gapId: gap.id,
  };
}

describe.skipIf(!hasDatabase)('cross-tenant isolation', () => {
  let a: World;
  let b: World;

  beforeAll(async () => {
    // The shim is idempotent on bare Postgres; on real Supabase auth already exists
    // and is owned by supabase_admin, so applying the shim is skipped.
    const [authExists] = await query<{ exists: boolean }>(
      `select (to_regclass('auth.users') is not null) as exists`
    );
    if (!authExists?.exists) {
      const shim = await readFile(resolve(import.meta.dirname, 'auth-shim.sql'), 'utf8');
      await query(shim);
    }
    a = await makeWorld('alpha');
    b = await makeWorld('beta');
  }, 60_000);

  afterAll(async () => {
    await closePool();
  });

  it('sets up two tenants that are actually distinct', () => {
    expect(a.tenantId).not.toBe(b.tenantId);
    expect(a.flagId).not.toBe(b.flagId);
  });

  describe('reads', () => {
    it("does not return another tenant's tickets, even with their project id", async () => {
      expect(await listTicketsForProject(a.tenantId, b.projectId)).toEqual([]);
      const own = await listTicketsForProject(a.tenantId, a.projectId);
      expect(own).toHaveLength(1);
    });

    it("does not return another tenant's analysis runs", async () => {
      expect(await listRunsForTicket(a.tenantId, b.ticketId)).toEqual([]);
      expect(await listRunsForTicket(a.tenantId, a.ticketId)).toHaveLength(1);
    });

    it("does not return another tenant's flags", async () => {
      expect(await listFlagsForVersion(a.tenantId, b.ticketVersionId)).toEqual([]);
      expect(await listOpenFlagsForTicket(a.tenantId, b.ticketId)).toEqual([]);
      expect(await listFlagsForVersion(a.tenantId, a.ticketVersionId)).toHaveLength(1);
    });

    it("does not return another tenant's decision history", async () => {
      await decideFlag(b.tenantId, { flagId: b.flagId, userId: b.userId, decision: 'accepted' });
      expect(await listDecisionsForFlag(a.tenantId, b.flagId)).toEqual([]);
      expect(await listDecisionsForFlag(b.tenantId, b.flagId)).toHaveLength(1);
    });

    it("does not return another tenant's reviewer gaps", async () => {
      expect(await listGaps(a.tenantId, b.sessionId)).toEqual([]);
      expect(await listGaps(a.tenantId, a.sessionId)).toHaveLength(1);
    });

    it("does not return another tenant's readiness events", async () => {
      expect(await listReadinessEvents(a.tenantId, b.ticketId)).toEqual([]);
      expect((await listReadinessEvents(a.tenantId, a.ticketId)).length).toBeGreaterThan(0);
    });

    it('counts only its own token usage', async () => {
      // Both tenants logged 150 tokens. A leak here would read as 300.
      expect(await monthlyTokenUsage(a.tenantId)).toBe(150);
      expect(await monthlyTokenUsage(b.tenantId)).toBe(150);
    });

    it('reports time-to-ready only for its own tickets', async () => {
      const rows = await timeToReady(a.tenantId);
      expect(rows.every((r) => r.ticketId !== b.ticketId)).toBe(true);
    });
  });

  describe('writes', () => {
    it("refuses to decide another tenant's flag", async () => {
      await expect(
        decideFlag(a.tenantId, { flagId: b.flagId, userId: a.userId, decision: 'dismissed' })
      ).rejects.toThrow(/no such flag/);

      // And the flag is untouched: still whatever tenant B set it to.
      const [row] = await query<{ status: string }>(`select status from flags where id = $1`, [
        b.flagId,
      ]);
      expect(row?.status).toBe('accepted');
    });

    it("refuses to add a gap to another tenant's labeling session", async () => {
      await expect(addGap(a.tenantId, b.sessionId, 'injected')).rejects.toThrow(
        /no such labeling session/
      );
      expect(await listGaps(b.tenantId, b.sessionId)).toHaveLength(1);
    });

    it("refuses to lock or reveal another tenant's session", async () => {
      await expect(lockGaps(a.tenantId, b.sessionId)).rejects.toThrow(/no such labeling session/);
      await expect(flagsForReveal(a.tenantId, b.sessionId)).rejects.toThrow(
        /no such labeling session/
      );
    });

    it("refuses to link another tenant's gap", async () => {
      await lockGaps(b.tenantId, b.sessionId);
      await flagsForReveal(b.tenantId, b.sessionId);
      await expect(linkGap(a.tenantId, b.sessionId, b.gapId, b.flagId)).rejects.toThrow(
        /no such labeling session/
      );
      const gaps = await listGaps(b.tenantId, b.sessionId);
      expect(gaps[0]?.matched_flag_id).toBeNull();
    });

    it('refuses to link a flag from a different ticket version', async () => {
      // Tenant B's own session, but tenant A's flag id: the tenant matches, the
      // version does not. This is the check that stops a gap being credited to a
      // flag raised against different ticket text.
      await expect(linkGap(b.tenantId, b.sessionId, b.gapId, a.flagId)).rejects.toThrow(
        /does not belong to this ticket version/
      );
    });

    it("refuses to mark another tenant's ticket ready", async () => {
      await expect(markReady(a.tenantId, b.ticketId, a.userId)).rejects.toThrow(
        /no analyzed version/
      );
    });
  });
});

describe.skipIf(hasDatabase)('cross-tenant isolation', () => {
  it('is skipped without DATABASE_URL — CI provides one', () => {
    expect(hasDatabase).toBe(false);
  });
});
