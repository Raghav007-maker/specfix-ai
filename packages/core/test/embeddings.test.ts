/**
 * The embedding transport's guarantees, tested without a model.
 *
 * The API client is replaced with a stub, so nothing here leaves the process. What is
 * under test is everything around the request: batching, order preservation across
 * skipped and reordered inputs, the dimension check against the pgvector column, and —
 * the reason this file exists — that a failed batch always leaves a call record behind,
 * because llm_calls is the only place embedding spend becomes visible.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type * as ConfigModule from '../src/config.ts';

const { create, config } = vi.hoisted(() => ({
  create: vi.fn(),
  config: { modelEmbed: 'text-embedding-3-small', maxTransportRetries: 0 },
}));

vi.mock('../src/openai.ts', () => ({
  getClient: () => ({ embeddings: { create } }),
}));

// No API key in the offline run, so the real getConfig would refuse to load. Retries
// default to off so a failing stub fails once, immediately; the retry tests turn
// them on.
vi.mock('../src/config.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof ConfigModule>();
  return {
    ...actual,
    getConfig: () => config as unknown as ReturnType<typeof actual.getConfig>,
  };
});

import {
  cosineSimilarity,
  embedText,
  embedTexts,
  embedTextsTolerant,
  toVectorLiteral,
  EmbeddingCallError,
  EmbeddingDimensionError,
  EMBEDDING_BATCH_SIZE,
  EMBEDDING_DIMENSIONS,
} from '../src/embeddings.ts';
import { costUsd } from '../src/cost.ts';

const MODEL = 'text-embedding-3-small';

/**
 * A vector that identifies its source text: component 0 carries the number in the
 * text ("t42" -> 42), so an output vector can be traced back to the input it belongs
 * to. Component 1 keeps the norm non-zero for "t0".
 */
function vectorFor(text: string, dims = EMBEDDING_DIMENSIONS): number[] {
  const vector = new Array<number>(dims).fill(0);
  vector[0] = Number(text.replace(/\D/g, '') || 0);
  vector[1] = 1;
  return vector;
}

function respond(input: string[], options: { dims?: number; reverse?: boolean } = {}) {
  const data = input.map((text, index) => ({
    object: 'embedding' as const,
    index,
    embedding: vectorFor(text, options.dims),
  }));
  return {
    object: 'list' as const,
    model: MODEL,
    usage: { prompt_tokens: input.length * 10, total_tokens: input.length * 10 },
    data: options.reverse ? [...data].reverse() : data,
  };
}

function texts(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `t${i}`);
}

/** An API error the retry loop treats as permanent, so the stub is called once. */
function badRequest(message: string): Error {
  return Object.assign(new Error(message), { status: 400 });
}

function sentInputs(): string[][] {
  return create.mock.calls.map(([body]) => (body as { input: string[] }).input);
}

beforeEach(() => {
  config.maxTransportRetries = 0;
  create.mockReset();
  create.mockImplementation(async ({ input }: { input: string[] }) => respond(input));
});

describe('cosineSimilarity', () => {
  it('is 1 for identical direction, regardless of magnitude', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1);
  });

  it('is 0 for orthogonal vectors and -1 for opposite ones', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([1, 2], [-1, -2])).toBeCloseTo(-1);
  });

  it('returns 0 rather than NaN for empty, mismatched or zero vectors', () => {
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});

describe('toVectorLiteral', () => {
  it("formats pgvector's text input", () => {
    expect(toVectorLiteral([0.1, -2, 3])).toBe('[0.1,-2,3]');
  });

  it('returns null for an empty vector so a zero-width embedding cannot be stored', () => {
    expect(toVectorLiteral([])).toBeNull();
  });
});

describe('EmbeddingDimensionError', () => {
  it('names both widths so the fix is obvious from the message', () => {
    const error = new EmbeddingDimensionError(1536, 3072);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('EmbeddingDimensionError');
    expect(error.expected).toBe(1536);
    expect(error.actual).toBe(3072);
    expect(error.message).toContain('1536');
    expect(error.message).toContain('3072');
  });
});

describe('embedTexts', () => {
  it(`splits input into batches of ${EMBEDDING_BATCH_SIZE}, one call record each`, async () => {
    const input = texts(EMBEDDING_BATCH_SIZE * 2 + 8);
    const outcome = await embedTexts(input);

    expect(sentInputs().map((batch) => batch.length)).toEqual([
      EMBEDDING_BATCH_SIZE,
      EMBEDDING_BATCH_SIZE,
      8,
    ]);
    expect(outcome.calls).toHaveLength(3);
    expect(outcome.calls.map((call) => call.request.inputCount)).toEqual([
      EMBEDDING_BATCH_SIZE,
      EMBEDDING_BATCH_SIZE,
      8,
    ]);
  });

  it('returns one vector per input, aligned with input order across batches', async () => {
    const input = texts(EMBEDDING_BATCH_SIZE + 5);
    const outcome = await embedTexts(input);

    expect(outcome.vectors).toHaveLength(input.length);
    outcome.vectors.forEach((vector, i) => {
      expect(vector).toHaveLength(EMBEDDING_DIMENSIONS);
      expect(vector[0]).toBe(i);
    });
  });

  it('places vectors by the response index, not the response order', async () => {
    create.mockImplementation(async ({ input }: { input: string[] }) =>
      respond(input, { reverse: true })
    );
    const outcome = await embedTexts(texts(4));
    expect(outcome.vectors.map((vector) => vector[0])).toEqual([0, 1, 2, 3]);
  });

  it('records model, tokens, cost and a zero output count on success', async () => {
    const outcome = await embedTexts(texts(3), { promptVersion: 'embedding-test' });
    const [call] = outcome.calls;

    expect(call).toMatchObject({
      purpose: 'embed',
      promptVersion: 'embedding-test',
      model: MODEL,
      inputTokens: 30,
      outputTokens: 0,
      costUsd: costUsd(MODEL, 30, 0),
      error: null,
    });
    expect(call?.latencyMs).toBeGreaterThanOrEqual(0);
    expect(call?.response).toMatchObject({ dimensions: EMBEDDING_DIMENSIONS });
  });

  it('defaults the prompt version and falls back to an estimate when usage is absent', async () => {
    create.mockImplementation(async ({ input }: { input: string[] }) => ({
      ...respond(input),
      usage: undefined,
    }));
    const outcome = await embedTexts(['t1 abcd']);
    const [call] = outcome.calls;

    expect(call?.promptVersion).toBe('embedding-v1');
    expect(call?.inputTokens).toBe(call?.request.inputTokensEstimated);
    expect(call?.inputTokens).toBeGreaterThan(0);
  });

  it('does not send blank inputs, trims the rest, and keeps their slots as []', async () => {
    const outcome = await embedTexts(['  t1  ', '', '   \n ', 't3']);

    expect(sentInputs()).toEqual([['t1', 't3']]);
    expect(outcome.skippedEmpty).toBe(2);
    expect(outcome.vectors).toHaveLength(4);
    expect(outcome.vectors[0]?.[0]).toBe(1);
    expect(outcome.vectors[1]).toEqual([]);
    expect(outcome.vectors[2]).toEqual([]);
    expect(outcome.vectors[3]?.[0]).toBe(3);
  });

  it('makes no request at all when every input is blank', async () => {
    const outcome = await embedTexts(['', '  ']);
    expect(create).not.toHaveBeenCalled();
    expect(outcome.calls).toEqual([]);
    expect(outcome.vectors).toEqual([[], []]);
    expect(outcome.skippedEmpty).toBe(2);
  });

  it('rejects a wrong-width vector, keeping the spent tokens on the failed record', async () => {
    create.mockImplementation(async ({ input }: { input: string[] }) =>
      respond(input, { dims: 3072 })
    );

    const error = await embedTexts(texts(2)).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(EmbeddingCallError);
    const callError = error as EmbeddingCallError;
    expect(callError.cause).toBeInstanceOf(EmbeddingDimensionError);
    expect(callError.calls).toHaveLength(1);
    expect(callError.calls[0]?.error).toContain('3072');
    // The API answered, so the call cost money even though its vectors are unusable.
    expect(callError.calls[0]?.inputTokens).toBe(20);
    expect(callError.calls[0]?.costUsd).toBe(costUsd(MODEL, 20, 0));
  });

  it('stops at a failed batch and throws with every record so far, the failed one included', async () => {
    create
      .mockImplementationOnce(async ({ input }: { input: string[] }) => respond(input))
      .mockRejectedValueOnce(badRequest('deployment not found'));

    const error = await embedTexts(texts(EMBEDDING_BATCH_SIZE * 2 + 1)).catch((e: unknown) => e);

    expect(create).toHaveBeenCalledTimes(2);
    expect(error).toBeInstanceOf(EmbeddingCallError);
    const callError = error as EmbeddingCallError;
    expect(callError.message).toBe('deployment not found');
    expect((callError.cause as Error).message).toBe('deployment not found');
    expect(callError.calls).toHaveLength(2);
    expect(callError.calls[0]?.error).toBeNull();
    expect(callError.calls[1]).toMatchObject({
      purpose: 'embed',
      error: 'deployment not found',
      response: null,
      inputTokens: 0,
      costUsd: 0,
    });
  });
});

describe('embedText', () => {
  it('returns the single vector, or [] for blank input', async () => {
    expect((await embedText('t7'))[0]).toBe(7);
    expect(await embedText('   ')).toEqual([]);
  });
});

describe('embedTextsTolerant', () => {
  it('attempts every batch after a failure and records the failed call', async () => {
    create
      .mockImplementationOnce(async ({ input }: { input: string[] }) => respond(input))
      .mockRejectedValueOnce(badRequest('content filtered'))
      .mockImplementationOnce(async ({ input }: { input: string[] }) => respond(input));

    const input = texts(EMBEDDING_BATCH_SIZE * 2 + 4);
    const outcome = await embedTextsTolerant(input);

    expect(create).toHaveBeenCalledTimes(3);
    expect(outcome.calls).toHaveLength(3);
    expect(outcome.calls.map((call) => call.error)).toEqual([null, 'content filtered', null]);
    expect(outcome.failedBatches).toBe(1);

    const failedRange = Array.from(
      { length: EMBEDDING_BATCH_SIZE },
      (_, i) => EMBEDDING_BATCH_SIZE + i
    );
    expect(outcome.failedIndices).toEqual(failedRange);

    // Rows in the failed batch are empty; rows on either side still got their vectors.
    outcome.vectors.forEach((vector, i) => {
      if (failedRange.includes(i)) expect(vector).toEqual([]);
      else expect(vector[0]).toBe(i);
    });
  });

  it('totals tokens and cost across all calls, failed ones contributing what they spent', async () => {
    create
      .mockImplementationOnce(async ({ input }: { input: string[] }) => respond(input))
      .mockRejectedValueOnce(badRequest('boom'));

    const outcome = await embedTextsTolerant(texts(EMBEDDING_BATCH_SIZE + 2));

    expect(outcome.totalInputTokens).toBe(EMBEDDING_BATCH_SIZE * 10);
    expect(outcome.totalCostUsd).toBeCloseTo(costUsd(MODEL, EMBEDDING_BATCH_SIZE * 10, 0));
  });

  it('leaves a whole batch empty when one vector in it has the wrong width', async () => {
    create.mockImplementation(async ({ input }: { input: string[] }) => {
      const response = respond(input);
      const last = response.data[response.data.length - 1];
      if (last) last.embedding = [1, 2, 3];
      return response;
    });

    const outcome = await embedTextsTolerant(texts(3));

    expect(outcome.failedBatches).toBe(1);
    expect(outcome.failedIndices).toEqual([0, 1, 2]);
    expect(outcome.vectors).toEqual([[], [], []]);
    expect(outcome.calls[0]?.error).toContain('3 dimensions');
  });

  it('reports blank inputs as skipped, not failed', async () => {
    const outcome = await embedTextsTolerant(['t0', '', 't2']);

    expect(outcome.failedBatches).toBe(0);
    expect(outcome.failedIndices).toEqual([]);
    expect(outcome.skippedEmpty).toBe(1);
    expect(outcome.vectors.map((vector) => vector[0])).toEqual([0, undefined, 2]);
  });
});

describe('transport retries', () => {
  /** Backoff delays the retry loop asked for, in order. */
  let delays: number[];
  let timeoutSpy: { mockRestore(): void };
  let randomSpy: { mockRestore(): void };

  /** An API error with an HTTP status, as the OpenAI SDK throws them. */
  const httpError = (status: number, message: string): Error =>
    Object.assign(new Error(message), { status });

  const succeed = async ({ input }: { input: string[] }) => respond(input);

  beforeEach(() => {
    config.maxTransportRetries = 3;
    delays = [];
    // Backoff sleeps resolve immediately and record what they were asked for, so the
    // schedule is asserted exactly without waiting on it. Vitest keeps its own timer
    // references, so its runner is unaffected.
    timeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      callback: () => void,
      ms?: number
    ) => {
      delays.push(ms ?? 0);
      callback();
      return 0;
    }) as unknown as typeof setTimeout);
    // Jitter is base * 0.25 * (2r - 1); r = 0.5 makes it exactly zero.
    randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  afterEach(() => {
    timeoutSpy.mockRestore();
    randomSpy.mockRestore();
  });

  it('retries a 429 with backoff and records one successful call', async () => {
    create.mockRejectedValueOnce(httpError(429, 'rate limited')).mockImplementationOnce(succeed);

    const outcome = await embedTexts(texts(2));

    expect(create).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([500]);
    // One record per batch: a transport retry is part of the call, not a second call.
    expect(outcome.calls).toHaveLength(1);
    expect(outcome.calls[0]).toMatchObject({ error: null, inputTokens: 20 });
    expect(outcome.vectors.map((vector) => vector[0])).toEqual([0, 1]);
  });

  it.each([500, 502, 503, 504, 408, 409])('retries a %i', async (status) => {
    create
      .mockRejectedValueOnce(httpError(status, `status ${status}`))
      .mockImplementationOnce(succeed);

    const outcome = await embedTexts(texts(1));

    expect(create).toHaveBeenCalledTimes(2);
    expect(outcome.calls[0]?.error).toBeNull();
  });

  it('retries a network error that carries no HTTP status', async () => {
    create
      .mockRejectedValueOnce(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))
      .mockImplementationOnce(succeed);

    await embedTexts(texts(1));

    expect(create).toHaveBeenCalledTimes(2);
  });

  it.each([400, 401, 403, 404, 422])('does not retry a %i', async (status) => {
    create.mockRejectedValueOnce(httpError(status, `status ${status}`));

    await expect(embedTexts(texts(1))).rejects.toBeInstanceOf(EmbeddingCallError);
    expect(create).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it('backs off 0.5s, 1s, 2s and then gives up, recording the last error', async () => {
    create.mockRejectedValue(httpError(503, 'service unavailable'));

    const error = await embedTexts(texts(2)).catch((e: unknown) => e);

    // The first attempt plus maxTransportRetries (3) retries.
    expect(create).toHaveBeenCalledTimes(4);
    expect(delays).toEqual([500, 1000, 2000]);
    expect(error).toBeInstanceOf(EmbeddingCallError);
    const callError = error as EmbeddingCallError;
    expect((callError.cause as { status?: number }).status).toBe(503);
    expect(callError.calls).toHaveLength(1);
    expect(callError.calls[0]).toMatchObject({
      purpose: 'embed',
      error: 'service unavailable',
      response: null,
      inputTokens: 0,
      costUsd: 0,
      request: { inputCount: 2 },
    });
    expect(callError.calls[0]?.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('keeps jitter within ±25% of each backoff step', async () => {
    create.mockRejectedValue(httpError(503, 'down'));

    randomSpy.mockRestore();
    randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    await embedTexts(texts(1)).catch(() => {});
    expect(delays).toEqual([375, 750, 1500]);

    delays.length = 0;
    randomSpy.mockRestore();
    randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.999999);
    await embedTexts(texts(1)).catch(() => {});
    delays.forEach((delay, i) => {
      const base = 500 * 2 ** i;
      expect(delay).toBeGreaterThan(base);
      expect(delay).toBeLessThanOrEqual(base * 1.25);
    });
  });

  it('does not retry at all when maxTransportRetries is 0', async () => {
    config.maxTransportRetries = 0;
    create.mockRejectedValueOnce(httpError(429, 'rate limited'));

    await expect(embedTexts(texts(1))).rejects.toBeInstanceOf(EmbeddingCallError);
    expect(create).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it('does not retry a dimension mismatch, which a resend could not fix', async () => {
    create.mockImplementation(async ({ input }: { input: string[] }) =>
      respond(input, { dims: 3072 })
    );

    await expect(embedTexts(texts(1))).rejects.toBeInstanceOf(EmbeddingCallError);
    expect(create).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it('lets the tolerant path move on after one batch exhausts its retries', async () => {
    create
      .mockRejectedValueOnce(httpError(503, 'down'))
      .mockRejectedValueOnce(httpError(503, 'down'))
      .mockRejectedValueOnce(httpError(503, 'down'))
      .mockRejectedValueOnce(httpError(503, 'down'))
      .mockImplementation(succeed);

    const outcome = await embedTextsTolerant(texts(EMBEDDING_BATCH_SIZE + 1));

    expect(create).toHaveBeenCalledTimes(5);
    expect(outcome.failedBatches).toBe(1);
    expect(outcome.calls.map((call) => call.error)).toEqual(['down', null]);
    expect(outcome.vectors[EMBEDDING_BATCH_SIZE]?.[0]).toBe(EMBEDDING_BATCH_SIZE);
  });
});
