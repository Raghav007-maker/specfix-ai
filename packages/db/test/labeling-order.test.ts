/**
 * Blind-first ordering, enforced by the server.
 *
 * The plan's central methodological fix is that a reviewer writes their own gap list
 * before seeing the model's flags. If that ordering is only a UI convention, then one
 * refactor, one deep link, or one impatient reviewer with the API quietly turns recall
 * into a number that measures nothing. So the ordering is a server rule, and this is
 * the test that holds it.
 *
 * Skipped without SPECFIX_TEST_DATABASE_URL; CI provides one. That variable, and not
 * DATABASE_URL, is the gate: this suite writes fixtures, so it must never inherit the
 * credentials the app runs on. See test/setup-db.ts.
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
  recordAnalysis,
  startSession,
  addGap,
  removeGap,
  lockGaps,
  flagsForReveal,
  linkGap,
  completeSession,
  listGaps,
  findSession,
  revealedFlags,
  recallCounts,
  doubleLabeledVersions,
} from '../src/index.ts';

const hasDatabase = Boolean(process.env.SPECFIX_TEST_DATABASE_URL);

interface Fixture {
  tenantId: string;
  userId: string;
  secondUserId: string;
  ticketVersionId: string;
  flagId: string;
}

async function setup(label: string): Promise<Fixture> {
  const tenant = await createTenant(`labeling-${label}`);
  const users = await query<{ id: string }>(
    `insert into auth.users (email) values ($1), ($2) returning id`,
    [
      `${label}-a-${Math.random().toString(36).slice(2)}@example.test`,
      `${label}-b-${Math.random().toString(36).slice(2)}@example.test`,
    ]
  );
  const userId = users[0]?.id;
  const secondUserId = users[1]?.id;
  if (!userId || !secondUserId) throw new Error('could not create test users');

  await addMembership(tenant.id, userId, 'reviewer');
  await addMembership(tenant.id, secondUserId, 'reviewer');

  const project = await createProject(tenant.id, { name: label, sourceType: 'file' });
  const ingested = await ingestTicket(tenant.id, project.id, {
    externalId: `${label}-1`,
    externalKey: `${label}-1`,
    title: 'Allow partial refunds',
    descriptionText: 'Agents should refund part of an order.',
    acceptanceCriteriaText: '- Agent enters an amount',
    raw: {},
    sourceUpdatedAt: null,
  });

  const analysis = await recordAnalysis(tenant.id, {
    ticketId: ingested.ticket.id,
    ticketVersionId: ingested.version.id,
    meta: {
      promptVersion: 'single-shot-v1@000000000000',
      model: 'gpt-4o-mini',
      temperature: 0,
      seed: 1337,
      truncated: false,
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0,
    },
    flags: [
      {
        category: 'missing_info',
        quoted_span: 'refund part of an order',
        what_unclear: 'no currency or rounding rule is stated',
        why_it_matters: 'the amount cannot be computed',
        question_for_pm: 'which currency and rounding?',
        severity: 'high',
        dedupeKey: 'missing_info:no-currency-or-rounding-rule-is-stated',
      },
    ],
    calls: [],
  });

  const flagId = analysis.flagIds[0];
  if (!flagId) throw new Error('expected a flag');

  return {
    tenantId: tenant.id,
    userId,
    secondUserId,
    ticketVersionId: ingested.version.id,
    flagId,
  };
}

describe.skipIf(!hasDatabase)('blind-first labeling order', () => {
  let f: Fixture;

  beforeAll(async () => {
    const shim = await readFile(resolve(import.meta.dirname, 'auth-shim.sql'), 'utf8');
    await query(shim);
    f = await setup('blind');
  }, 60_000);

  afterAll(async () => {
    await closePool();
  });

  it('refuses to reveal flags before the gap list is locked', async () => {
    const session = await startSession(f.tenantId, f.ticketVersionId, f.userId);
    expect(session.stage).toBe('blind_gaps');

    // The load-bearing assertion of the whole measurement design.
    await expect(flagsForReveal(f.tenantId, session.id)).rejects.toThrow(
      /before the reviewer's own gap list is locked/
    );
  });

  it('refuses to add a gap after the lock', async () => {
    const f2 = await setup('after-lock');
    const session = await startSession(f2.tenantId, f2.ticketVersionId, f2.userId);
    await addGap(f2.tenantId, session.id, 'no currency stated');
    await lockGaps(f2.tenantId, session.id);

    await expect(addGap(f2.tenantId, session.id, 'thought of another one')).rejects.toThrow(
      /gaps are locked/
    );
    await expect(removeGap(f2.tenantId, session.id, 'whatever')).rejects.toThrow(/gaps are locked/);
    expect(await listGaps(f2.tenantId, session.id)).toHaveLength(1);
  });

  it('walks the full flow and produces a recall denominator', async () => {
    const f3 = await setup('full-flow');
    const session = await startSession(f3.tenantId, f3.ticketVersionId, f3.userId);

    const caught = await addGap(f3.tenantId, session.id, 'no currency or rounding rule');
    const missed = await addGap(f3.tenantId, session.id, 'no cap on number of partial refunds');
    expect(await listGaps(f3.tenantId, session.id)).toHaveLength(2);

    await lockGaps(f3.tenantId, session.id);
    const revealed = await flagsForReveal(f3.tenantId, session.id);
    expect(revealed.session.stage).toBe('link');
    expect(revealed.session.revealed_at).not.toBeNull();
    expect(revealed.flags).toHaveLength(1);

    await linkGap(f3.tenantId, session.id, caught.id, f3.flagId);
    // `missed` is deliberately left unlinked — that is a recall miss, and the metric
    // has to be able to represent one.
    await completeSession(f3.tenantId, session.id);

    const counts = await recallCounts(f3.tenantId);
    expect(counts).toEqual({ gaps: 2, matched: 1 });

    const gaps = await listGaps(f3.tenantId, session.id);
    expect(gaps.find((g) => g.id === missed.id)?.matched_flag_id).toBeNull();
  });

  it('lets a reviewer unlink, and the gap goes back to being a miss', async () => {
    const f4 = await setup('unlink');
    const session = await startSession(f4.tenantId, f4.ticketVersionId, f4.userId);
    const gap = await addGap(f4.tenantId, session.id, 'no currency stated');
    await lockGaps(f4.tenantId, session.id);
    await flagsForReveal(f4.tenantId, session.id);

    await linkGap(f4.tenantId, session.id, gap.id, f4.flagId);
    const unlinked = await linkGap(f4.tenantId, session.id, gap.id, null);
    expect(unlinked.matched_flag_id).toBeNull();
    expect(unlinked.matched_at).toBeNull();
  });

  it('allows locking an empty gap list, because "nothing unclear here" is a real label', async () => {
    const f5 = await setup('empty');
    const session = await startSession(f5.tenantId, f5.ticketVersionId, f5.userId);
    const locked = await lockGaps(f5.tenantId, session.id);
    expect(locked.stage).toBe('reveal');
    const revealed = await flagsForReveal(f5.tenantId, session.id);
    expect(revealed.flags).toHaveLength(1);
    await completeSession(f5.tenantId, session.id);
  });

  it('refuses to link before the reveal', async () => {
    const f6 = await setup('early-link');
    const session = await startSession(f6.tenantId, f6.ticketVersionId, f6.userId);
    const gap = await addGap(f6.tenantId, session.id, 'something');
    await lockGaps(f6.tenantId, session.id);
    await expect(linkGap(f6.tenantId, session.id, gap.id, f6.flagId)).rejects.toThrow(
      /have not been revealed/
    );
  });

  it('refuses to complete a session that never revealed', async () => {
    const f7 = await setup('no-reveal');
    const session = await startSession(f7.tenantId, f7.ticketVersionId, f7.userId);
    await lockGaps(f7.tenantId, session.id);
    await expect(completeSession(f7.tenantId, session.id)).rejects.toThrow(
      /never reached the reveal stage/
    );
  });

  it('resumes an interrupted session rather than starting a second one', async () => {
    const f8 = await setup('resume');
    const first = await startSession(f8.tenantId, f8.ticketVersionId, f8.userId);
    await addGap(f8.tenantId, first.id, 'partial work');
    const again = await startSession(f8.tenantId, f8.ticketVersionId, f8.userId);
    expect(again.id).toBe(first.id);
    expect(await listGaps(f8.tenantId, first.id)).toHaveLength(1);
  });

  it('gives a second reviewer their own session, which is the inter-rater overlap', async () => {
    const f9 = await setup('overlap');

    for (const reviewer of [f9.userId, f9.secondUserId]) {
      const session = await startSession(f9.tenantId, f9.ticketVersionId, reviewer);
      await addGap(f9.tenantId, session.id, 'no currency stated');
      await lockGaps(f9.tenantId, session.id);
      await flagsForReveal(f9.tenantId, session.id);
      await completeSession(f9.tenantId, session.id);
    }

    expect(await doubleLabeledVersions(f9.tenantId)).toEqual([f9.ticketVersionId]);
    // Two reviewers, one gap each: the denominator is 2, not 1. Deduplicating here
    // would silently discard the disagreement the overlap exists to measure.
    expect((await recallCounts(f9.tenantId)).gaps).toBe(2);
  });

  // The dashboard re-reads flags on every render of the review page. It must go
  // through a gate that is just as strict as the one guarding the transition, and it
  // must not itself perform the reveal — otherwise merely loading (or prefetching) a
  // page would stamp revealed_at for a reviewer who never saw anything.
  describe('revealedFlags, the read-only gate the dashboard renders through', () => {
    it('refuses to return flags before the gap list is locked', async () => {
      const f10 = await setup('read-gate');
      const session = await startSession(f10.tenantId, f10.ticketVersionId, f10.userId);
      await addGap(f10.tenantId, session.id, 'no currency stated');

      await expect(revealedFlags(f10.tenantId, session.id)).rejects.toThrow(
        /before the reviewer's own gap list is locked/
      );
    });

    it('does not reveal: reading never advances the session', async () => {
      const f11 = await setup('read-no-write');
      const session = await startSession(f11.tenantId, f11.ticketVersionId, f11.userId);
      const gap = await addGap(f11.tenantId, session.id, 'no currency stated');
      await lockGaps(f11.tenantId, session.id);

      const read = await revealedFlags(f11.tenantId, session.id);
      expect(read.flags).toHaveLength(1);
      // Locked but never revealed: the stage and timestamp are untouched by the read.
      expect(read.session.revealed_at).toBeNull();
      expect(read.session.stage).toBe('reveal');

      const stored = await findSession(f11.tenantId, f11.ticketVersionId, f11.userId);
      expect(stored?.revealed_at).toBeNull();

      // The proof that the read did not stand in for the transition: linking is still
      // refused, because as far as the server is concerned the reveal has not happened.
      await expect(linkGap(f11.tenantId, session.id, gap.id, f11.flagId)).rejects.toThrow(
        /have not been revealed/
      );
    });

    it('is scoped to the tenant, so another tenant cannot read a session', async () => {
      const mine = await setup('read-mine');
      const theirs = await setup('read-theirs');
      const session = await startSession(mine.tenantId, mine.ticketVersionId, mine.userId);
      await lockGaps(mine.tenantId, session.id);

      await expect(revealedFlags(theirs.tenantId, session.id)).rejects.toThrow(
        /no such labeling session/
      );
    });
  });

  describe('findSession', () => {
    it('returns null instead of creating one, so a page render has no side effect', async () => {
      const f12 = await setup('find');
      expect(await findSession(f12.tenantId, f12.ticketVersionId, f12.userId)).toBeNull();

      const started = await startSession(f12.tenantId, f12.ticketVersionId, f12.userId);
      const found = await findSession(f12.tenantId, f12.ticketVersionId, f12.userId);
      expect(found?.id).toBe(started.id);
    });
  });
});
