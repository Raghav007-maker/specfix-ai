/**
 * Embedding repository SQL and the lifecycle sync, against a real Postgres + pgvector.
 *
 * The offline embedding-sync suite covers the sync's decisions with a fake repository;
 * this one covers what a fake cannot: that the queries run at all (an earlier version
 * referenced a `tickets.current_version_id` column the schema never had, which only a
 * database can reveal), that the requirement text the sync stores is byte-identical to
 * what the staleness check computes, that the conditional scenario write really is
 * conditional, and that nothing crosses tenants.
 *
 * The embedder is a fake — no model is called. Skipped without
 * SPECFIX_TEST_DATABASE_URL, like the other fixture-writing suites; CI provides one.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NormalizedTicket } from '@specfix/shared';
import {
  clauseCoverage,
  clauseEmbeddingsAvailable,
  closePool,
  createProject,
  createTenant,
  decideScenario,
  driftedScenarios,
  embeddingCounts,
  getClauseEmbeddingState,
  getRequirementEmbeddingSources,
  getScenarioEmbeddingSource,
  ingestTicket,
  listScenariosMissingEmbeddings,
  listVersionsMissingClauseEmbeddings,
  listStaleRequirementEmbeddings,
  listVersionsMissingEmbeddings,
  query,
  recordCompilation,
  recordEmbeddingCalls,
  replaceClauseEmbeddings,
  syncClauseEmbeddings,
  syncRequirementEmbeddings,
  syncScenarioEmbedding,
  upsertScenarioEmbeddingIfCurrent,
  type EmbedFn,
} from '../src/index.ts';

const hasDatabase = Boolean(process.env.SPECFIX_TEST_DATABASE_URL);
const MODEL = 'text-embedding-3-small';

// One pool for the whole file, closed once: closing it between describe blocks makes the
// next block reconnect mid-run for no benefit.
afterAll(async () => {
  if (hasDatabase) await closePool();
});

/** A valid 1536-dimension vector; `seed` only varies it. */
function vector(seed: number): number[] {
  return Array.from({ length: 1536 }, (_, i) => (i === 0 ? seed : i === 1 ? 1 : 0));
}

const fakeEmbed: EmbedFn = async (texts) => ({
  vectors: texts.map((text) => vector(text.length)),
  calls: [
    {
      promptVersion: 'embedding-v1',
      model: MODEL,
      request: { inputCount: texts.length },
      response: { model: MODEL },
      latencyMs: 1,
      inputTokens: 7,
      outputTokens: 0,
      costUsd: 0.0000001,
      error: null,
    },
  ],
});

function ticket(key: string, ac: string): NormalizedTicket {
  return {
    externalId: key,
    externalKey: key,
    title: `Ticket ${key}`,
    // Leading/trailing spaces and a tab: where Postgres trim and JavaScript trim differ.
    descriptionText: `  Description for ${key}.\t `,
    acceptanceCriteriaText: ac,
    raw: { key },
    sourceUpdatedAt: null,
  };
}

interface World {
  tenantId: string;
  userId: string;
  oldVersionId: string;
  currentVersionId: string;
  ticketId: string;
  scenarioId: string;
}

async function makeWorld(label: string): Promise<World> {
  const tenant = await createTenant(`embed-${label}`);
  const [user] = await query<{ id: string }>(
    `insert into auth.users (email) values ($1) returning id`,
    [`embed-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`]
  );
  if (!user) throw new Error('could not create test user');
  const project = await createProject(tenant.id, { name: `p-${label}`, sourceType: 'file' });

  const first = await ingestTicket(tenant.id, project.id, ticket(`${label}-1`, '- it works'));
  // Different text: a second version, which supersedes the first.
  const second = await ingestTicket(
    tenant.id,
    project.id,
    ticket(`${label}-1`, '- it works\n- and it is fast')
  );

  const compiled = await recordCompilation(tenant.id, {
    ticketId: second.ticket.id,
    ticketVersionId: second.version.id,
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
        gherkin: 'Scenario: it works\n  Given a user\n  Then it works',
        covers_ac: 'it works',
        rationale: 'covers the AC',
        dedupeKey: `${label}-it-works`,
        sourceFlagIds: [],
      },
    ],
    calls: [],
  });
  const scenarioId = compiled.scenarioIds[0];
  if (!scenarioId) throw new Error('expected a scenario');

  return {
    tenantId: tenant.id,
    userId: user.id,
    oldVersionId: first.version.id,
    currentVersionId: second.version.id,
    ticketId: second.ticket.id,
    scenarioId,
  };
}

describe.skipIf(!hasDatabase)('embedding repository and lifecycle sync', () => {
  let a: World;
  let b: World;

  beforeAll(async () => {
    a = await makeWorld(`a-${Date.now()}`);
    b = await makeWorld(`b-${Date.now()}`);
  });

  it("lists only each ticket's current version as missing, and counts it", async () => {
    const missing = await listVersionsMissingEmbeddings(a.tenantId);
    expect(missing.map((row) => row.ticketVersionId)).toEqual([a.currentVersionId]);

    const counts = await embeddingCounts(a.tenantId);
    expect(counts.versionsAwaiting).toBe(1);
    expect(counts.requirements).toBe(0);
  });

  it('reports current-ness and the embeddable text, and nothing from another tenant', async () => {
    const sources = await getRequirementEmbeddingSources(a.tenantId, [
      a.oldVersionId,
      a.currentVersionId,
      b.currentVersionId,
    ]);
    const byId = new Map(sources.map((source) => [source.ticketVersionId, source]));

    expect(byId.size).toBe(2);
    expect(byId.get(a.oldVersionId)?.isCurrent).toBe(false);
    expect(byId.get(a.currentVersionId)?.isCurrent).toBe(true);
    expect(byId.has(b.currentVersionId)).toBe(false);

    const [listed] = await listVersionsMissingEmbeddings(a.tenantId);
    expect(byId.get(a.currentVersionId)?.content).toBe(listed?.content);
  });

  it('embeds the current version on sync, skips the old one, and logs the call', async () => {
    const result = await syncRequirementEmbeddings(
      a.tenantId,
      [a.oldVersionId, a.currentVersionId],
      { embed: fakeEmbed, model: MODEL }
    );

    expect(result.outcomes).toEqual([
      { id: a.oldVersionId, outcome: { status: 'skipped', reason: 'not_current' } },
      { id: a.currentVersionId, outcome: { status: 'embedded' } },
    ]);

    // Byte-identical to the staleness expression, so the fresh vector is not "stale".
    expect(await listStaleRequirementEmbeddings(a.tenantId)).toEqual([]);
    expect((await embeddingCounts(a.tenantId)).versionsAwaiting).toBe(0);

    const logged = await query<{ purpose: string; analysis_run_id: null; compile_run_id: null }>(
      `select purpose, analysis_run_id, compile_run_id from llm_calls
        where tenant_id = $1 and purpose = 'embed'`,
      [a.tenantId]
    );
    expect(logged).toEqual([{ purpose: 'embed', analysis_run_id: null, compile_run_id: null }]);

    const again = await syncRequirementEmbeddings(a.tenantId, [a.currentVersionId], {
      embed: async () => {
        throw new Error('must not be called for an unchanged version');
      },
      model: MODEL,
    });
    expect(again.outcomes[0]?.outcome).toEqual({ status: 'unchanged' });

    // Tenant B was untouched.
    expect((await embeddingCounts(b.tenantId)).requirements).toBe(0);
  });

  it('refuses to embed a draft scenario, and embeds it once approved', async () => {
    const draft = await syncScenarioEmbedding(a.tenantId, a.scenarioId, {
      embed: fakeEmbed,
      model: MODEL,
    });
    expect(draft.outcomes[0]?.outcome).toEqual({ status: 'skipped', reason: 'not_accepted' });
    expect(
      await upsertScenarioEmbeddingIfCurrent(a.tenantId, {
        scenarioId: a.scenarioId,
        content: 'Scenario: it works\n  Given a user\n  Then it works',
        embedding: vector(1),
        model: MODEL,
      })
    ).toBe(false);

    await decideScenario(a.tenantId, {
      scenarioId: a.scenarioId,
      userId: a.userId,
      decision: 'approved',
    });
    const approved = await syncScenarioEmbedding(a.tenantId, a.scenarioId, {
      embed: fakeEmbed,
      model: MODEL,
    });
    expect(approved.outcomes[0]?.outcome).toEqual({ status: 'embedded' });
    expect((await embeddingCounts(a.tenantId)).scenariosAwaiting).toBe(0);
  });

  it('treats an edited scenario with an old vector as needing one, and refreshes it', async () => {
    const edited = 'Scenario: it works quickly\n  Given a user\n  Then it works within 1s';
    await decideScenario(a.tenantId, {
      scenarioId: a.scenarioId,
      userId: a.userId,
      decision: 'edited',
      editedText: edited,
    });

    // The old vector is still there but no longer matches — it is back on the work list.
    const missing = await listScenariosMissingEmbeddings(a.tenantId);
    expect(missing.map((row) => row.scenarioId)).toEqual([a.scenarioId]);

    // A write for the superseded text is refused.
    expect(
      await upsertScenarioEmbeddingIfCurrent(a.tenantId, {
        scenarioId: a.scenarioId,
        content: 'Scenario: it works\n  Given a user\n  Then it works',
        embedding: vector(2),
        model: MODEL,
      })
    ).toBe(false);

    const refreshed = await syncScenarioEmbedding(a.tenantId, a.scenarioId, {
      embed: fakeEmbed,
      model: MODEL,
    });
    expect(refreshed.outcomes[0]?.outcome).toEqual({ status: 'embedded' });
    expect((await getScenarioEmbeddingSource(a.tenantId, a.scenarioId))?.embeddedContent).toBe(
      edited
    );
    expect(await listScenariosMissingEmbeddings(a.tenantId)).toEqual([]);
  });

  it("cannot read or write another tenant's scenario vector", async () => {
    expect(await getScenarioEmbeddingSource(b.tenantId, a.scenarioId)).toBeNull();
    expect(
      await upsertScenarioEmbeddingIfCurrent(b.tenantId, {
        scenarioId: a.scenarioId,
        content: 'Scenario: it works quickly\n  Given a user\n  Then it works within 1s',
        embedding: vector(3),
        model: MODEL,
      })
    ).toBe(false);
    const sync = await syncScenarioEmbedding(b.tenantId, a.scenarioId, {
      embed: fakeEmbed,
      model: MODEL,
    });
    expect(sync.outcomes[0]?.outcome).toEqual({ status: 'skipped', reason: 'not_found' });
    expect((await embeddingCounts(b.tenantId)).scenarios).toBe(0);
  });

  it('logs embed calls with no run reference and the given tenant', async () => {
    await recordEmbeddingCalls(b.tenantId, [
      {
        promptVersion: 'embedding-v1',
        model: MODEL,
        request: { inputCount: 1 },
        response: null,
        latencyMs: 2,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        error: 'service unavailable',
      },
    ]);
    const rows = await query<{ error: string; response: unknown }>(
      `select error, response from llm_calls where tenant_id = $1 and purpose = 'embed'`,
      [b.tenantId]
    );
    expect(rows).toEqual([{ error: 'service unavailable', response: null }]);
  });
});

describe.skipIf(!hasDatabase)(
  'clause embeddings, clause coverage and drift (migration 0006)',
  () => {
    let world: World;
    let staleVersionId: string;
    let driftScenarioId: string;

    beforeAll(async () => {
      world = await makeWorld(`c-${Date.now()}`);

      // A ticket whose approved scenario will drift: approve + embed it on v1, then change
      // the text so v2 supersedes it.
      const project = await createProject(world.tenantId, { name: 'drift', sourceType: 'file' });
      const v1 = await ingestTicket(
        world.tenantId,
        project.id,
        ticket('drift-1', '- refunds are allowed')
      );
      staleVersionId = v1.version.id;
      const compiled = await recordCompilation(world.tenantId, {
        ticketId: v1.ticket.id,
        ticketVersionId: v1.version.id,
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
            title: 'refunds are allowed',
            gherkin: 'Scenario: refund\n  Given an order\n  Then a refund is allowed',
            covers_ac: 'refunds are allowed',
            rationale: 'covers the AC',
            dedupeKey: 'drift-refund',
            sourceFlagIds: [],
          },
        ],
        calls: [],
      });
      driftScenarioId = compiled.scenarioIds[0] as string;
      await decideScenario(world.tenantId, {
        scenarioId: driftScenarioId,
        userId: world.userId,
        decision: 'approved',
      });
      await syncScenarioEmbedding(world.tenantId, driftScenarioId, {
        embed: fakeEmbed,
        model: MODEL,
      });
      const v2 = await ingestTicket(
        world.tenantId,
        project.id,
        ticket('drift-1', '- refunds are allowed within 30 days')
      );
      await syncClauseEmbeddings(world.tenantId, [v2.version.id], {
        embed: fakeEmbed,
        model: MODEL,
      });
      world = { ...world, ticketId: v2.ticket.id, currentVersionId: v2.version.id };
    });

    it('stores one vector per clause and treats an unchanged set as current', async (ctx) => {
      if (!(await clauseEmbeddingsAvailable())) ctx.skip();
      const [state] = await getClauseEmbeddingState(world.tenantId, [world.currentVersionId]);
      expect(state?.stored.map((c) => [c.clauseIndex, c.content])).toEqual([
        [0, 'refunds are allowed within 30 days'],
      ]);

      const again = await syncClauseEmbeddings(world.tenantId, [world.currentVersionId], {
        embed: async () => {
          throw new Error('must not be called for unchanged clauses');
        },
        model: MODEL,
      });
      expect(again.outcomes[0]?.outcome).toEqual({ status: 'unchanged' });
    });

    it('does not list a version with clause vectors as missing, and skips the stale one', async (ctx) => {
      if (!(await clauseEmbeddingsAvailable())) ctx.skip();
      const missing = (await listVersionsMissingClauseEmbeddings(world.tenantId)).map(
        (row) => row.ticketVersionId
      );
      expect(missing).not.toContain(world.currentVersionId);
      expect(missing).not.toContain(staleVersionId);
    });

    it('reports a previously approved, now stale scenario as drift with its closest clause', async (ctx) => {
      if (!(await clauseEmbeddingsAvailable())) ctx.skip();
      const drift = await driftedScenarios(world.tenantId, {
        ticketId: world.ticketId,
        currentVersionId: world.currentVersionId,
      });
      expect(drift).toHaveLength(1);
      expect(drift[0]).toMatchObject({
        scenarioId: driftScenarioId,
        ticketVersionId: staleVersionId,
        clauseIndex: 0,
        clauseContent: 'refunds are allowed within 30 days',
      });
      expect(typeof drift[0]?.similarity).toBe('number');
    });

    it('ranks the current version’s accepted scenarios against each clause', async (ctx) => {
      if (!(await clauseEmbeddingsAvailable())) ctx.skip();
      // The drift ticket's current version has no accepted scenario yet: a row, no match.
      const rows = await clauseCoverage(world.tenantId, world.currentVersionId);
      expect(rows).toEqual([
        {
          clauseIndex: 0,
          content: 'refunds are allowed within 30 days',
          scenarioId: null,
          scenarioTitle: null,
          similarity: null,
        },
      ]);
    });

    it("cannot read or replace another tenant's clause vectors", async (ctx) => {
      if (!(await clauseEmbeddingsAvailable())) ctx.skip();
      const other = await createTenant(`clause-other-${Date.now()}`);
      expect(await getClauseEmbeddingState(other.id, [world.currentVersionId])).toEqual([]);
      expect(await clauseCoverage(other.id, world.currentVersionId)).toEqual([]);
      const written = await replaceClauseEmbeddings(other.id, [
        {
          ticketVersionId: world.currentVersionId,
          model: MODEL,
          clauses: [{ clauseIndex: 0, content: 'hijack', embedding: vector(9) }],
        },
      ]);
      expect(written).toBe(0);
      // The owner's clause set is intact.
      const [state] = await getClauseEmbeddingState(world.tenantId, [world.currentVersionId]);
      expect(state?.stored.map((c) => c.content)).toEqual(['refunds are allowed within 30 days']);
    });
  }
);
