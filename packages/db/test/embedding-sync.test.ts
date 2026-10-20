/**
 * Lifecycle embedding sync, tested without a database or a model.
 *
 * The repository is an in-memory fake keyed by tenant, so tenant isolation is checked
 * as behaviour (a row in another tenant is invisible) rather than as an argument
 * assertion alone, and the embedder is a fake that never leaves the process. What is
 * under test is every decision the sync makes: when to spend, what to log, in what
 * order, and how each failure is reported — the SQL itself is covered by the
 * database-backed embeddings-repo suite.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  describeEmbeddingProblem,
  syncClauseEmbeddings,
  syncRequirementEmbeddings,
  syncScenarioEmbedding,
  type EmbedFn,
  type EmbeddingSyncRepo,
} from '../src/embedding-sync.ts';
import type {
  ClauseEmbeddingState,
  ClauseEmbeddingWrite,
  EmbeddingCallInput,
  RequirementEmbeddingSource,
  ScenarioEmbeddingSource,
} from '../src/repositories/embeddings.ts';

const TENANT = 'tenant-a';
const OTHER_TENANT = 'tenant-b';
const MODEL = 'text-embedding-3-small';

function apiCall(overrides: Partial<EmbeddingCallInput> = {}): EmbeddingCallInput {
  return {
    promptVersion: 'embedding-v1',
    model: MODEL,
    request: { inputCount: 1, inputTokensEstimated: 5 },
    response: { model: MODEL, dimensions: 2 },
    latencyMs: 3,
    inputTokens: 5,
    outputTokens: 0,
    costUsd: 0.0000001,
    error: null,
    ...overrides,
  };
}

/** A working embedder: one call record per request, a vector derived from the text. */
function fakeEmbed(): EmbedFn & ReturnType<typeof vi.fn> {
  return vi.fn(async (texts: readonly string[]) => ({
    vectors: texts.map((text) => [text.length, 1]),
    calls: [apiCall({ request: { inputCount: texts.length } })],
  })) as unknown as EmbedFn & ReturnType<typeof vi.fn>;
}

/** An embedder whose request failed after retries, the way embedTextsTolerant reports it. */
function failingEmbed(error = 'service unavailable'): EmbedFn & ReturnType<typeof vi.fn> {
  return vi.fn(async (texts: readonly string[]) => ({
    vectors: texts.map(() => []),
    calls: [apiCall({ error, response: null, inputTokens: 0, costUsd: 0 })],
  })) as unknown as EmbedFn & ReturnType<typeof vi.fn>;
}

interface Store {
  requirements: Map<string, RequirementEmbeddingSource & { tenantId: string }>;
  scenarios: Map<string, ScenarioEmbeddingSource & { tenantId: string }>;
  loggedCalls: { tenantId: string; calls: readonly EmbeddingCallInput[] }[];
  requirementWrites: {
    tenantId: string;
    ticketVersionId: string;
    content: string;
    model: string;
  }[];
  scenarioWrites: { tenantId: string; scenarioId: string; content: string; model: string }[];
  clauseVersions: Map<string, ClauseEmbeddingState & { tenantId: string }>;
  clauseWrites: { tenantId: string; writes: readonly ClauseEmbeddingWrite[] }[];
  /** Whether migration 0006 is "applied" in this fake. */
  clauseTable: boolean;
  order: string[];
}

function fakeRepo(overrides: Partial<EmbeddingSyncRepo> = {}) {
  const store: Store = {
    requirements: new Map(),
    scenarios: new Map(),
    loggedCalls: [],
    requirementWrites: [],
    scenarioWrites: [],
    clauseVersions: new Map(),
    clauseWrites: [],
    clauseTable: true,
    order: [],
  };

  const repo: EmbeddingSyncRepo = {
    getRequirementEmbeddingSources: async (tenantId, ids) =>
      ids.flatMap((id) => {
        const row = store.requirements.get(id);
        return row && row.tenantId === tenantId ? [row] : [];
      }),
    getScenarioEmbeddingSource: async (tenantId, id) => {
      const row = store.scenarios.get(id);
      return row && row.tenantId === tenantId ? row : null;
    },
    recordEmbeddingCalls: async (tenantId, calls) => {
      store.order.push('recordEmbeddingCalls');
      store.loggedCalls.push({ tenantId, calls });
      return calls.length;
    },
    upsertEmbeddingBatch: async (tenantId, input) => {
      store.order.push('upsertEmbeddingBatch');
      for (const write of input.requirements) {
        store.requirementWrites.push({ tenantId, ...write });
        const row = store.requirements.get(write.ticketVersionId);
        if (row) Object.assign(row, { embeddedContent: write.content, embeddedModel: write.model });
      }
      return {};
    },
    upsertScenarioEmbeddingIfCurrent: async (tenantId, input) => {
      store.order.push('upsertScenarioEmbeddingIfCurrent');
      const row = store.scenarios.get(input.scenarioId);
      const current =
        !!row &&
        row.tenantId === tenantId &&
        row.content === input.content &&
        (row.status === 'approved' || row.status === 'edited');
      if (!current) return false;
      store.scenarioWrites.push({ tenantId, ...input });
      Object.assign(row, { embeddedContent: input.content, embeddedModel: input.model });
      return true;
    },
    clauseEmbeddingsAvailable: async () => store.clauseTable,
    getClauseEmbeddingState: async (tenantId, ids) =>
      ids.flatMap((id) => {
        const row = store.clauseVersions.get(id);
        return row && row.tenantId === tenantId ? [row] : [];
      }),
    replaceClauseEmbeddings: async (tenantId, writes) => {
      store.order.push('replaceClauseEmbeddings');
      store.clauseWrites.push({ tenantId, writes });
      for (const write of writes) {
        const row = store.clauseVersions.get(write.ticketVersionId);
        if (row && row.tenantId === tenantId) {
          row.stored = write.clauses.map((clause) => ({
            clauseIndex: clause.clauseIndex,
            content: clause.content,
            model: write.model,
          }));
        }
      }
      return writes.length;
    },
    ...overrides,
  };

  const addClauseVersion = (
    id: string,
    fields: Partial<ClauseEmbeddingState> = {},
    tenantId = TENANT
  ) =>
    store.clauseVersions.set(id, {
      tenantId,
      ticketVersionId: id,
      acceptanceCriteriaText: '- Agent can enter an amount\n- The customer is notified',
      isCurrent: true,
      stored: [],
      ...fields,
    });

  const addVersion = (
    id: string,
    fields: Partial<RequirementEmbeddingSource> = {},
    tenantId = TENANT
  ) =>
    store.requirements.set(id, {
      tenantId,
      ticketVersionId: id,
      content: `- ${id} acceptance criteria\nDescription of ${id}`,
      isCurrent: true,
      embeddedContent: null,
      embeddedModel: null,
      ...fields,
    });

  const addScenario = (
    id: string,
    fields: Partial<ScenarioEmbeddingSource> = {},
    tenantId = TENANT
  ) =>
    store.scenarios.set(id, {
      tenantId,
      scenarioId: id,
      ticketVersionId: 'v1',
      status: 'approved',
      content: `Scenario: ${id}\n  Given a thing\n  Then it works`,
      embeddedContent: null,
      embeddedModel: null,
      ...fields,
    });

  return { repo, store, addVersion, addScenario, addClauseVersion };
}

const outcomeOf = (result: { outcomes: { id: string; outcome: unknown }[] }, id: string) =>
  result.outcomes.find((entry) => entry.id === id)?.outcome;

describe('syncRequirementEmbeddings (ticket ingestion)', () => {
  it('embeds a new version, logging the call before writing the vector', async () => {
    const { repo, store, addVersion } = fakeRepo();
    addVersion('v1');
    const embed = fakeEmbed();

    const result = await syncRequirementEmbeddings(TENANT, ['v1'], { embed, model: MODEL }, repo);

    expect(outcomeOf(result, 'v1')).toEqual({ status: 'embedded' });
    expect(embed).toHaveBeenCalledWith([store.requirements.get('v1')?.content]);
    expect(store.order).toEqual(['recordEmbeddingCalls', 'upsertEmbeddingBatch']);
    expect(store.loggedCalls).toEqual([{ tenantId: TENANT, calls: result.calls }]);
    expect(store.requirementWrites).toEqual([
      {
        tenantId: TENANT,
        ticketVersionId: 'v1',
        content: store.requirements.get('v1')?.content,
        embedding: expect.any(Array),
        model: MODEL,
      },
    ]);
    expect(result.callLogError).toBeNull();
  });

  it('makes no API call when the stored vector already matches the text and model', async () => {
    const { repo, store, addVersion } = fakeRepo();
    addVersion('v1');
    const row = store.requirements.get('v1');
    addVersion('v1', { embeddedContent: row?.content ?? '', embeddedModel: MODEL });
    const embed = fakeEmbed();

    const result = await syncRequirementEmbeddings(TENANT, ['v1'], { embed, model: MODEL }, repo);

    expect(outcomeOf(result, 'v1')).toEqual({ status: 'unchanged' });
    expect(embed).not.toHaveBeenCalled();
    expect(store.loggedCalls).toEqual([]);
    expect(store.requirementWrites).toEqual([]);
  });

  it('is idempotent: a second sync of the same version spends nothing', async () => {
    const { repo, addVersion } = fakeRepo();
    addVersion('v1');
    const embed = fakeEmbed();

    await syncRequirementEmbeddings(TENANT, ['v1'], { embed, model: MODEL }, repo);
    const second = await syncRequirementEmbeddings(TENANT, ['v1'], { embed, model: MODEL }, repo);

    expect(embed).toHaveBeenCalledTimes(1);
    expect(outcomeOf(second, 'v1')).toEqual({ status: 'unchanged' });
  });

  it('re-embeds when the stored text differs from the version text', async () => {
    const { repo, store, addVersion } = fakeRepo();
    addVersion('v1', {
      embeddedContent: 'text from before the trim rules changed',
      embeddedModel: MODEL,
    });
    const embed = fakeEmbed();

    const result = await syncRequirementEmbeddings(TENANT, ['v1'], { embed, model: MODEL }, repo);

    expect(outcomeOf(result, 'v1')).toEqual({ status: 'embedded' });
    expect(store.requirements.get('v1')?.embeddedContent).toBe(
      store.requirements.get('v1')?.content
    );
  });

  it('re-embeds when the configured model changed', async () => {
    const { repo, store, addVersion } = fakeRepo();
    addVersion('v1');
    const content = store.requirements.get('v1')?.content ?? '';
    addVersion('v1', { embeddedContent: content, embeddedModel: 'an-older-model' });
    const embed = fakeEmbed();

    await syncRequirementEmbeddings(TENANT, ['v1'], { embed, model: MODEL }, repo);

    expect(embed).toHaveBeenCalledTimes(1);
  });

  it('skips superseded, blank and unknown versions without spending', async () => {
    const { repo, addVersion } = fakeRepo();
    addVersion('old', { isCurrent: false });
    addVersion('blank', { content: '   ' });
    const embed = fakeEmbed();

    const result = await syncRequirementEmbeddings(
      TENANT,
      ['old', 'blank', 'missing'],
      { embed, model: MODEL },
      repo
    );

    expect(embed).not.toHaveBeenCalled();
    expect(outcomeOf(result, 'old')).toEqual({ status: 'skipped', reason: 'not_current' });
    expect(outcomeOf(result, 'blank')).toEqual({ status: 'skipped', reason: 'blank' });
    expect(outcomeOf(result, 'missing')).toEqual({ status: 'skipped', reason: 'not_found' });
  });

  it("does not see, embed or write another tenant's version", async () => {
    const { repo, store, addVersion } = fakeRepo();
    addVersion('theirs', {}, OTHER_TENANT);
    const embed = fakeEmbed();

    const result = await syncRequirementEmbeddings(
      TENANT,
      ['theirs'],
      { embed, model: MODEL },
      repo
    );

    expect(outcomeOf(result, 'theirs')).toEqual({ status: 'skipped', reason: 'not_found' });
    expect(embed).not.toHaveBeenCalled();
    expect(store.requirementWrites).toEqual([]);
  });

  it('embeds everything that needs it in one request, deduplicating ids', async () => {
    const { repo, store, addVersion } = fakeRepo();
    addVersion('a');
    addVersion('b');
    addVersion('c');
    const c = store.requirements.get('c');
    addVersion('c', { embeddedContent: c?.content ?? '', embeddedModel: MODEL });
    const embed = fakeEmbed();

    const result = await syncRequirementEmbeddings(
      TENANT,
      ['a', 'b', 'a', 'c'],
      { embed, model: MODEL },
      repo
    );

    expect(embed).toHaveBeenCalledTimes(1);
    expect((embed.mock.calls[0]?.[0] as string[]).length).toBe(2);
    expect(result.outcomes.map((entry) => entry.id)).toEqual(['a', 'b', 'c']);
    expect(store.requirementWrites.map((write) => write.ticketVersionId)).toEqual(['a', 'b']);
  });

  it('logs the failed call and writes nothing when the API fails', async () => {
    const { repo, store, addVersion } = fakeRepo();
    addVersion('v1');

    const result = await syncRequirementEmbeddings(
      TENANT,
      ['v1'],
      { embed: failingEmbed('service unavailable'), model: MODEL },
      repo
    );

    expect(outcomeOf(result, 'v1')).toEqual({
      status: 'failed',
      stage: 'embed',
      error: 'service unavailable',
    });
    expect(store.loggedCalls).toHaveLength(1);
    expect(store.loggedCalls[0]?.calls[0]?.error).toBe('service unavailable');
    expect(store.requirementWrites).toEqual([]);
  });

  it('logs the call records a throwing embedder attaches to its error', async () => {
    const { repo, store, addVersion } = fakeRepo();
    addVersion('v1');
    const attached = [apiCall({ error: 'dimension mismatch', inputTokens: 5 })];
    const embed: EmbedFn = async () => {
      throw Object.assign(new Error('dimension mismatch'), { calls: attached });
    };

    const result = await syncRequirementEmbeddings(TENANT, ['v1'], { embed, model: MODEL }, repo);

    expect(outcomeOf(result, 'v1')).toMatchObject({ status: 'failed', stage: 'embed' });
    expect(store.loggedCalls).toEqual([{ tenantId: TENANT, calls: attached }]);
  });

  it('reports a configuration error without logging anything, since no call was made', async () => {
    const { repo, store, addVersion } = fakeRepo();
    addVersion('v1');
    const embed: EmbedFn = async () => {
      throw new Error('Invalid configuration: OPENAI_API_KEY or AZURE_OPENAI_API_KEY is required');
    };

    const result = await syncRequirementEmbeddings(TENANT, ['v1'], { embed, model: MODEL }, repo);

    expect(outcomeOf(result, 'v1')).toMatchObject({ status: 'failed', stage: 'embed' });
    expect(store.loggedCalls).toEqual([]);
  });

  it('does not store a vector whose call could not be logged, and returns the records', async () => {
    const { repo, store, addVersion } = fakeRepo({
      recordEmbeddingCalls: async () => {
        throw new Error('connection terminated');
      },
    });
    addVersion('v1');

    const result = await syncRequirementEmbeddings(
      TENANT,
      ['v1'],
      { embed: fakeEmbed(), model: MODEL },
      repo
    );

    expect(outcomeOf(result, 'v1')).toEqual({
      status: 'failed',
      stage: 'record_calls',
      error: 'connection terminated',
    });
    expect(result.callLogError).toBe('connection terminated');
    expect(result.calls).toHaveLength(1);
    expect(store.requirementWrites).toEqual([]);
  });

  it('reports a failed vector write after the call was logged', async () => {
    const { repo, store, addVersion } = fakeRepo({
      upsertEmbeddingBatch: async () => {
        throw new Error('deadlock detected');
      },
    });
    addVersion('v1');

    const result = await syncRequirementEmbeddings(
      TENANT,
      ['v1'],
      { embed: fakeEmbed(), model: MODEL },
      repo
    );

    expect(outcomeOf(result, 'v1')).toEqual({
      status: 'failed',
      stage: 'write_vector',
      error: 'deadlock detected',
    });
    expect(store.loggedCalls).toHaveLength(1);
    expect(result.callLogError).toBeNull();
  });

  it('reports a failed source read without calling the API', async () => {
    const embed = fakeEmbed();
    const { repo } = fakeRepo({
      getRequirementEmbeddingSources: async () => {
        throw new Error('timeout exceeded when trying to connect');
      },
    });

    const result = await syncRequirementEmbeddings(TENANT, ['v1'], { embed, model: MODEL }, repo);

    expect(outcomeOf(result, 'v1')).toMatchObject({ status: 'failed', stage: 'load' });
    expect(embed).not.toHaveBeenCalled();
  });

  it('does nothing at all for an empty list', async () => {
    const embed = fakeEmbed();
    const { repo, store } = fakeRepo();
    const result = await syncRequirementEmbeddings(TENANT, [], { embed, model: MODEL }, repo);
    expect(result.outcomes).toEqual([]);
    expect(embed).not.toHaveBeenCalled();
    expect(store.order).toEqual([]);
  });
});

describe('syncScenarioEmbedding (scenario review)', () => {
  it.each(['approved', 'edited'])(
    'embeds an %s scenario from its reviewed text',
    async (status) => {
      const { repo, store, addScenario } = fakeRepo();
      addScenario('s1', { status });
      const embed = fakeEmbed();

      const result = await syncScenarioEmbedding(TENANT, 's1', { embed, model: MODEL }, repo);

      expect(outcomeOf(result, 's1')).toEqual({ status: 'embedded' });
      expect(embed).toHaveBeenCalledWith([store.scenarios.get('s1')?.content]);
      expect(store.order).toEqual(['recordEmbeddingCalls', 'upsertScenarioEmbeddingIfCurrent']);
      expect(store.scenarioWrites).toEqual([
        {
          tenantId: TENANT,
          scenarioId: 's1',
          content: store.scenarios.get('s1')?.content,
          embedding: expect.any(Array),
          model: MODEL,
        },
      ]);
    }
  );

  it("replaces the vector when an edit changed the scenario's text", async () => {
    const { repo, store, addScenario } = fakeRepo();
    addScenario('s1', {
      status: 'edited',
      content: 'Scenario: reviewer wording\n  Given the edited step',
      embeddedContent: 'Scenario: compiler wording\n  Given the original step',
      embeddedModel: MODEL,
    });
    const embed = fakeEmbed();

    const result = await syncScenarioEmbedding(TENANT, 's1', { embed, model: MODEL }, repo);

    expect(outcomeOf(result, 's1')).toEqual({ status: 'embedded' });
    expect(embed).toHaveBeenCalledWith(['Scenario: reviewer wording\n  Given the edited step']);
    expect(store.scenarios.get('s1')?.embeddedContent).toBe(
      'Scenario: reviewer wording\n  Given the edited step'
    );
  });

  it('makes no API call when re-approved with unchanged text (e.g. after a reopen)', async () => {
    const { repo, store, addScenario } = fakeRepo();
    addScenario('s1');
    const content = store.scenarios.get('s1')?.content ?? '';
    addScenario('s1', { embeddedContent: content, embeddedModel: MODEL });
    const embed = fakeEmbed();

    const result = await syncScenarioEmbedding(TENANT, 's1', { embed, model: MODEL }, repo);

    expect(outcomeOf(result, 's1')).toEqual({ status: 'unchanged' });
    expect(embed).not.toHaveBeenCalled();
    expect(store.loggedCalls).toEqual([]);
  });

  it.each(['stale', 'draft', 'dismissed'])('never embeds a %s scenario', async (status) => {
    const { repo, store, addScenario } = fakeRepo();
    addScenario('s1', { status });
    const embed = fakeEmbed();

    const result = await syncScenarioEmbedding(TENANT, 's1', { embed, model: MODEL }, repo);

    expect(outcomeOf(result, 's1')).toEqual({ status: 'skipped', reason: 'not_accepted' });
    expect(embed).not.toHaveBeenCalled();
    expect(store.scenarioWrites).toEqual([]);
  });

  it("does not see another tenant's scenario", async () => {
    const { repo, store, addScenario } = fakeRepo();
    addScenario('s1', {}, OTHER_TENANT);
    const embed = fakeEmbed();

    const result = await syncScenarioEmbedding(TENANT, 's1', { embed, model: MODEL }, repo);

    expect(outcomeOf(result, 's1')).toEqual({ status: 'skipped', reason: 'not_found' });
    expect(embed).not.toHaveBeenCalled();
    expect(store.scenarioWrites).toEqual([]);
  });

  it('writes nothing when the scenario changed while it was being embedded', async () => {
    const { repo, store, addScenario } = fakeRepo();
    addScenario('s1');
    // A second reviewer edits the scenario after its text was read, before the write.
    const embed: EmbedFn = async (texts) => {
      addScenario('s1', { status: 'edited', content: 'Scenario: someone else edited this' });
      return { vectors: texts.map(() => [1, 2]), calls: [apiCall()] };
    };

    const result = await syncScenarioEmbedding(TENANT, 's1', { embed, model: MODEL }, repo);

    expect(outcomeOf(result, 's1')).toEqual({ status: 'skipped', reason: 'superseded' });
    expect(store.scenarioWrites).toEqual([]);
    // The spend still happened and is still logged.
    expect(store.loggedCalls).toHaveLength(1);
  });

  it('reports an API failure after the decision, with the failed call logged', async () => {
    const { repo, store, addScenario } = fakeRepo();
    addScenario('s1', { status: 'edited' });

    const result = await syncScenarioEmbedding(
      TENANT,
      's1',
      { embed: failingEmbed('rate limited'), model: MODEL },
      repo
    );

    expect(outcomeOf(result, 's1')).toEqual({
      status: 'failed',
      stage: 'embed',
      error: 'rate limited',
    });
    expect(store.loggedCalls[0]?.calls[0]?.error).toBe('rate limited');
    expect(store.scenarioWrites).toEqual([]);
  });

  it('reports a failed call log and does not store the vector', async () => {
    const { repo, store, addScenario } = fakeRepo({
      recordEmbeddingCalls: async () => {
        throw new Error('connection terminated');
      },
    });
    addScenario('s1');

    const result = await syncScenarioEmbedding(
      TENANT,
      's1',
      { embed: fakeEmbed(), model: MODEL },
      repo
    );

    expect(outcomeOf(result, 's1')).toMatchObject({ status: 'failed', stage: 'record_calls' });
    expect(result.calls).toHaveLength(1);
    expect(store.scenarioWrites).toEqual([]);
  });

  it('reports a failed vector write', async () => {
    const { repo, addScenario } = fakeRepo({
      upsertScenarioEmbeddingIfCurrent: async () => {
        throw new Error('deadlock detected');
      },
    });
    addScenario('s1');

    const result = await syncScenarioEmbedding(
      TENANT,
      's1',
      { embed: fakeEmbed(), model: MODEL },
      repo
    );

    expect(outcomeOf(result, 's1')).toEqual({
      status: 'failed',
      stage: 'write_vector',
      error: 'deadlock detected',
    });
  });
});

describe('describeEmbeddingProblem', () => {
  const result = (
    outcome: Parameters<typeof describeEmbeddingProblem>[0]['outcomes'][0]['outcome']
  ) => ({
    outcomes: [{ id: 's1', outcome }],
    calls: [],
    callLogError: null,
  });

  it('is null when the vector is current or not needed', () => {
    expect(describeEmbeddingProblem(result({ status: 'embedded' }))).toBeNull();
    expect(describeEmbeddingProblem(result({ status: 'unchanged' }))).toBeNull();
    expect(
      describeEmbeddingProblem(result({ status: 'skipped', reason: 'superseded' }))
    ).toBeNull();
  });

  it('names the failed step, the cause and the recovery for each failure', () => {
    const embed = describeEmbeddingProblem(
      result({ status: 'failed', stage: 'embed', error: 'rate limited' })
    );
    expect(embed).toContain('could not be generated (rate limited)');
    expect(embed).toContain('backfill');

    const log = describeEmbeddingProblem(
      result({ status: 'failed', stage: 'record_calls', error: 'connection terminated' })
    );
    expect(log).toContain('could not be logged');
    expect(log).toContain('not stored');
    expect(log).toContain('server log');

    const write = describeEmbeddingProblem(
      result({ status: 'failed', stage: 'write_vector', error: 'deadlock detected' })
    );
    expect(write).toContain('could not be stored (deadlock detected)');
    expect(write).toContain('was logged');

    expect(
      describeEmbeddingProblem(result({ status: 'failed', stage: 'load', error: 'timeout' }))
    ).toContain('could not be read (timeout)');
  });
});

describe('syncClauseEmbeddings (per-clause vectors)', () => {
  const CLAUSES = ['Agent can enter an amount', 'The customer is notified'];

  it('embeds each AC clause, split the way the eval splits it, and stores them as a set', async () => {
    const { repo, store, addClauseVersion } = fakeRepo();
    addClauseVersion('v1');
    const embed = fakeEmbed();

    const result = await syncClauseEmbeddings(TENANT, ['v1'], { embed, model: MODEL }, repo);

    expect(outcomeOf(result, 'v1')).toEqual({ status: 'embedded' });
    expect(embed).toHaveBeenCalledWith(CLAUSES);
    expect(store.order).toEqual(['recordEmbeddingCalls', 'replaceClauseEmbeddings']);
    expect(store.clauseWrites[0]?.tenantId).toBe(TENANT);
    expect(
      store.clauseWrites[0]?.writes[0]?.clauses.map((c) => [c.clauseIndex, c.content])
    ).toEqual([
      [0, CLAUSES[0]],
      [1, CLAUSES[1]],
    ]);
  });

  it('makes no API call when the stored clauses already match text and model', async () => {
    const { repo, addClauseVersion } = fakeRepo();
    addClauseVersion('v1', {
      stored: CLAUSES.map((content, clauseIndex) => ({ clauseIndex, content, model: MODEL })),
    });
    const embed = fakeEmbed();

    const result = await syncClauseEmbeddings(TENANT, ['v1'], { embed, model: MODEL }, repo);

    expect(outcomeOf(result, 'v1')).toEqual({ status: 'unchanged' });
    expect(embed).not.toHaveBeenCalled();
  });

  it('re-embeds the whole set when the clause count or a clause changed', async () => {
    const { repo, store, addClauseVersion } = fakeRepo();
    addClauseVersion('v1', {
      stored: [{ clauseIndex: 0, content: 'Agent can enter an amount', model: MODEL }],
    });
    const embed = fakeEmbed();

    await syncClauseEmbeddings(TENANT, ['v1'], { embed, model: MODEL }, repo);

    expect(embed).toHaveBeenCalledWith(CLAUSES);
    expect(store.clauseVersions.get('v1')?.stored.map((c) => c.content)).toEqual(CLAUSES);
  });

  it('batches several versions into one request and keeps each version’s clauses apart', async () => {
    const { repo, store, addClauseVersion } = fakeRepo();
    addClauseVersion('v1');
    addClauseVersion('v2', { acceptanceCriteriaText: '1. Refunds appear in history' });
    const embed = fakeEmbed();

    await syncClauseEmbeddings(TENANT, ['v1', 'v2'], { embed, model: MODEL }, repo);

    expect(embed).toHaveBeenCalledTimes(1);
    expect(embed).toHaveBeenCalledWith([...CLAUSES, 'Refunds appear in history']);
    const writes = store.clauseWrites[0]?.writes ?? [];
    expect(writes.map((w) => [w.ticketVersionId, w.clauses.length])).toEqual([
      ['v1', 2],
      ['v2', 1],
    ]);
    expect(writes[1]?.clauses[0]).toMatchObject({
      clauseIndex: 0,
      content: 'Refunds appear in history',
    });
  });

  it('writes no partial set when one clause of a version failed to embed', async () => {
    const { repo, store, addClauseVersion } = fakeRepo();
    addClauseVersion('v1');
    const embed: EmbedFn = async (texts) => ({
      vectors: texts.map((_, i) => (i === 1 ? [] : [1, 2])),
      calls: [apiCall(), apiCall({ error: 'content filtered', inputTokens: 0, costUsd: 0 })],
    });

    const result = await syncClauseEmbeddings(TENANT, ['v1'], { embed, model: MODEL }, repo);

    expect(outcomeOf(result, 'v1')).toEqual({
      status: 'failed',
      stage: 'embed',
      error: 'content filtered',
    });
    expect(store.clauseWrites).toEqual([]);
    expect(store.loggedCalls[0]?.calls).toHaveLength(2);
  });

  it('skips with schema_missing and spends nothing where migration 0006 is not applied', async () => {
    const { repo, store, addClauseVersion } = fakeRepo();
    store.clauseTable = false;
    addClauseVersion('v1');
    const embed = fakeEmbed();

    const result = await syncClauseEmbeddings(TENANT, ['v1'], { embed, model: MODEL }, repo);

    expect(outcomeOf(result, 'v1')).toEqual({ status: 'skipped', reason: 'schema_missing' });
    expect(embed).not.toHaveBeenCalled();
  });

  it('skips superseded versions, versions without AC, and other tenants’ versions', async () => {
    const { repo, addClauseVersion } = fakeRepo();
    addClauseVersion('old', { isCurrent: false });
    addClauseVersion('empty', { acceptanceCriteriaText: '  \n ' });
    addClauseVersion('theirs', {}, OTHER_TENANT);
    const embed = fakeEmbed();

    const result = await syncClauseEmbeddings(
      TENANT,
      ['old', 'empty', 'theirs'],
      { embed, model: MODEL },
      repo
    );

    expect(embed).not.toHaveBeenCalled();
    expect(result.outcomes.map((o) => o.outcome)).toEqual([
      { status: 'skipped', reason: 'not_current' },
      { status: 'skipped', reason: 'blank' },
      { status: 'skipped', reason: 'not_found' },
    ]);
  });

  it('does not store clause vectors whose calls could not be logged', async () => {
    const { repo, store, addClauseVersion } = fakeRepo({
      recordEmbeddingCalls: async () => {
        throw new Error('connection terminated');
      },
    });
    addClauseVersion('v1');

    const result = await syncClauseEmbeddings(
      TENANT,
      ['v1'],
      { embed: fakeEmbed(), model: MODEL },
      repo
    );

    expect(outcomeOf(result, 'v1')).toMatchObject({ status: 'failed', stage: 'record_calls' });
    expect(store.clauseWrites).toEqual([]);
  });

  it('reports a failed clause write after the calls were logged', async () => {
    const { repo, store, addClauseVersion } = fakeRepo({
      replaceClauseEmbeddings: async () => {
        throw new Error('deadlock detected');
      },
    });
    addClauseVersion('v1');

    const result = await syncClauseEmbeddings(
      TENANT,
      ['v1'],
      { embed: fakeEmbed(), model: MODEL },
      repo
    );

    expect(outcomeOf(result, 'v1')).toEqual({
      status: 'failed',
      stage: 'write_vector',
      error: 'deadlock detected',
    });
    expect(store.loggedCalls).toHaveLength(1);
  });
});
