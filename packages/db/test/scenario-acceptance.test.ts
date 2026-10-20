/**
 * scenarioAcceptanceCounts against a real Postgres: the acceptance-rate inputs come
 * from the review history, so the cases that matter are histories, not statuses — an
 * edit followed by an approve, an approve followed by a reopen, a verdict on a version
 * that has since gone stale.
 *
 * Skipped without SPECFIX_TEST_DATABASE_URL, like the other fixture-writing suites.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NormalizedTicket } from '@specfix/shared';
import {
  closePool,
  createProject,
  createTenant,
  decideScenario,
  ingestTicket,
  query,
  recordCompilation,
  scenarioAcceptanceCounts,
  type ScenarioInput,
} from '../src/index.ts';

const hasDatabase = Boolean(process.env.SPECFIX_TEST_DATABASE_URL);

afterAll(async () => {
  if (hasDatabase) await closePool();
});

function ticket(key: string, ac: string): NormalizedTicket {
  return {
    externalId: key,
    externalKey: key,
    title: `Ticket ${key}`,
    descriptionText: `Description for ${key}.`,
    acceptanceCriteriaText: ac,
    raw: { key },
    sourceUpdatedAt: null,
  };
}

function scenario(label: string, origin?: 'human'): ScenarioInput {
  return {
    title: label,
    gherkin: `Scenario: ${label}\n  Given a user\n  Then it works`,
    covers_ac: 'it works',
    rationale: 'covers the AC',
    dedupeKey: label,
    sourceFlagIds: [],
    ...(origin ? { origin } : {}),
  };
}

interface World {
  tenantId: string;
  userId: string;
  projectId: string;
  label: string;
  ids: Record<string, string>;
}

const LABELS = ['as-is', 'edited', 'edited-then-approved', 'dismissed', 'reopened', 'untouched'];

async function makeWorld(label: string): Promise<World> {
  const tenant = await createTenant(`acceptance-${label}`);
  const [user] = await query<{ id: string }>(
    `insert into auth.users (email) values ($1) returning id`,
    [`acceptance-${label}-${Math.random().toString(36).slice(2)}@example.test`]
  );
  if (!user) throw new Error('could not create test user');
  const project = await createProject(tenant.id, { name: `p-${label}`, sourceType: 'file' });
  const ingested = await ingestTicket(tenant.id, project.id, ticket(`${label}-1`, '- it works'));

  const compiled = await recordCompilation(tenant.id, {
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
    scenarios: [...LABELS.map((l) => scenario(l)), scenario('human-written', 'human')],
    calls: [],
  });

  const ids: Record<string, string> = {};
  [...LABELS, 'human-written'].forEach((l, i) => {
    const id = compiled.scenarioIds[i];
    if (!id) throw new Error(`expected a scenario for ${l}`);
    ids[l] = id;
  });
  return { tenantId: tenant.id, userId: user.id, projectId: project.id, label, ids };
}

async function decide(
  world: World,
  key: string,
  decision: 'approved' | 'edited' | 'dismissed' | 'reopened'
): Promise<void> {
  await decideScenario(world.tenantId, {
    scenarioId: world.ids[key] as string,
    userId: world.userId,
    decision,
    editedText: decision === 'edited' ? `Scenario: ${key}, reworded\n  Then it works` : undefined,
  });
}

describe.skipIf(!hasDatabase)('scenarioAcceptanceCounts', () => {
  let a: World;
  let b: World;

  beforeAll(async () => {
    a = await makeWorld(`a-${Date.now()}`);
    b = await makeWorld(`b-${Date.now()}`);

    await decide(a, 'as-is', 'approved');
    await decide(a, 'edited', 'edited');
    await decide(a, 'edited-then-approved', 'edited');
    await decide(a, 'edited-then-approved', 'approved');
    await decide(a, 'dismissed', 'dismissed');
    await decide(a, 'reopened', 'approved');
    await decide(a, 'reopened', 'reopened');
    // A human-written scenario's verdict must not reach the model's rates.
    await decide(a, 'human-written', 'approved');
  });

  it('counts each model scenario once, by its standing verdict', async () => {
    expect(await scenarioAcceptanceCounts(a.tenantId)).toEqual({
      acceptedAsIs: 1,
      // An approve after an edit is still the reviewer's wording, not the model's.
      acceptedAfterEdit: 2,
      dismissed: 1,
      // Reopened and never-reviewed alike: no standing verdict.
      undecided: 2,
      humanExcluded: 1,
    });
  });

  it('scopes by compile prompt name, with or without the content hash', async () => {
    const full = await scenarioAcceptanceCounts(a.tenantId);
    expect(await scenarioAcceptanceCounts(a.tenantId, 'compile-gherkin-v1')).toEqual(full);
    expect(await scenarioAcceptanceCounts(a.tenantId, 'compile-gherkin-v1@000000000000')).toEqual(
      full
    );
    // A different prompt, and a bare prefix of the name, both match nothing.
    for (const other of ['compile-gherkin-v2', 'compile-gherkin']) {
      expect(await scenarioAcceptanceCounts(a.tenantId, other)).toEqual({
        acceptedAsIs: 0,
        acceptedAfterEdit: 0,
        dismissed: 0,
        undecided: 0,
        humanExcluded: 0,
      });
    }
  });

  it('sees nothing from another tenant', async () => {
    expect(await scenarioAcceptanceCounts(b.tenantId)).toEqual({
      acceptedAsIs: 0,
      acceptedAfterEdit: 0,
      dismissed: 0,
      undecided: 6,
      humanExcluded: 1,
    });
  });

  it('keeps verdicts after the ticket changes and the scenarios go stale', async () => {
    const before = await scenarioAcceptanceCounts(a.tenantId);
    await ingestTicket(a.tenantId, a.projectId, ticket(`${a.label}-1`, '- it works\n- and more'));

    const [stale] = await query<{ n: string }>(
      `select count(*)::text as n from scenarios where tenant_id = $1 and status = 'stale'`,
      [a.tenantId]
    );
    expect(Number(stale?.n)).toBeGreaterThan(0);
    expect(await scenarioAcceptanceCounts(a.tenantId)).toEqual(before);
  });
});
