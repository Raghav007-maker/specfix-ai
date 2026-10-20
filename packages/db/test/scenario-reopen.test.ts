/**
 * Reopening a scenario restores the compiler's original Gherkin (migration 0007), so
 * an undecided draft never shows a reviewer's rewrite as if the model had written it.
 *
 * Skipped without SPECFIX_TEST_DATABASE_URL, like the other fixture-writing suites.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closePool,
  createProject,
  createTenant,
  decideScenario,
  ingestTicket,
  listScenarioReviews,
  query,
  recordCompilation,
} from '../src/index.ts';

const hasDatabase = Boolean(process.env.SPECFIX_TEST_DATABASE_URL);

afterAll(async () => {
  if (hasDatabase) await closePool();
});

const ORIGINAL = 'Scenario: it works\n  Given a user\n  Then it works';
const EDITED = 'Scenario: it works, reworded\n  Given a signed-in user\n  Then it works';

describe.skipIf(!hasDatabase)('reopening a scenario', () => {
  let tenantId: string;
  let userId: string;
  let scenarioId: string;

  beforeAll(async () => {
    const label = `reopen-${Date.now()}`;
    const tenant = await createTenant(label);
    tenantId = tenant.id;
    const [user] = await query<{ id: string }>(
      `insert into auth.users (email) values ($1) returning id`,
      [`${label}-${Math.random().toString(36).slice(2)}@example.test`]
    );
    if (!user) throw new Error('could not create test user');
    userId = user.id;
    const project = await createProject(tenantId, { name: `p-${label}`, sourceType: 'file' });
    const ingested = await ingestTicket(tenantId, project.id, {
      externalId: `${label}-1`,
      externalKey: `${label}-1`,
      title: 'Ticket',
      descriptionText: 'Description.',
      acceptanceCriteriaText: '- it works',
      raw: {},
      sourceUpdatedAt: null,
    });
    const compiled = await recordCompilation(tenantId, {
      ticketId: ingested.ticket.id,
      ticketVersionId: ingested.version.id,
      meta: {
        promptVersion: 'compile-gherkin-v1@000000000000',
        model: 'gpt-4o-mini',
        temperature: 0,
        seed: null,
        truncated: false,
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0,
      },
      scenarios: [
        {
          title: 'it works',
          gherkin: ORIGINAL,
          covers_ac: 'it works',
          rationale: 'covers the AC',
          dedupeKey: 'it-works',
          sourceFlagIds: [],
        },
      ],
      calls: [],
    });
    const id = compiled.scenarioIds[0];
    if (!id) throw new Error('expected a scenario');
    scenarioId = id;
  });

  it('shows the edit while edited, then the original once reopened', async () => {
    const edited = await decideScenario(tenantId, {
      scenarioId,
      userId,
      decision: 'edited',
      editedText: EDITED,
    });
    expect(edited.gherkin_raw).toBe(EDITED);

    const reopened = await decideScenario(tenantId, { scenarioId, userId, decision: 'reopened' });
    expect(reopened.status).toBe('draft');
    expect(reopened.gherkin_raw).toBe(ORIGINAL);

    // The audit trail still holds the reviewer's words; only the live text reverted.
    const reviews = await listScenarioReviews(tenantId, scenarioId);
    expect(reviews.map((r) => [r.decision, r.edited_text])).toEqual([
      ['edited', EDITED],
      ['reopened', null],
    ]);
  });

  it('keeps the current text on approve', async () => {
    const approved = await decideScenario(tenantId, { scenarioId, userId, decision: 'approved' });
    expect(approved.gherkin_raw).toBe(ORIGINAL);
  });

  it('keeps the current text on reopen when no original is stored (edited before 0007)', async () => {
    await decideScenario(tenantId, { scenarioId, userId, decision: 'reopened' });
    await decideScenario(tenantId, { scenarioId, userId, decision: 'edited', editedText: EDITED });
    await query(`update scenarios set gherkin_original = null where tenant_id = $1 and id = $2`, [
      tenantId,
      scenarioId,
    ]);

    const reopened = await decideScenario(tenantId, { scenarioId, userId, decision: 'reopened' });
    expect(reopened.gherkin_raw).toBe(EDITED);
  });
});
