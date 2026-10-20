/**
 * Embedding transport.
 *
 * Separate from openai.ts on purpose. The chat path is built around one structured
 * JSON object per call, a schema, and a corrective retry; none of that applies here.
 * What embeddings have instead is a different failure surface:
 *
 *  - a hard cap on inputs per request, so text has to be batched
 *  - no schema to fail, but a dimension that must match the pgvector column exactly,
 *    which is checked here rather than surfacing later as a Postgres insert error
 *  - cost that is input-only, so `costUsd` gets zero output tokens
 *
 * Retries are the same policy as the chat path: transient transport failures retry
 * with backoff, and anything else surfaces. A missing embedding is not something a
 * second attempt with identical input will fix, so the loop is bounded and shallow.
 */
import { getClient } from './openai.ts';
import { getConfig } from './config.ts';
import { costUsd } from './cost.ts';

/**
 * Dimensions the schema is declared with — `vector(1536)` in
 * packages/db/migrations/0003_specs.sql. `text-embedding-3-small` produces exactly
 * this; a different model here means a migration, not a config change.
 */
export const EMBEDDING_DIMENSIONS = 1536;

/**
 * Azure's embeddings endpoint accepts up to 2048 inputs per request. 96 is chosen
 * instead because it keeps a single request inside the token limit as well — 2048
 * full-length inputs would trip the per-request token ceiling before the input count.
 */
export const EMBEDDING_BATCH_SIZE = 96;

/** One recorded embedding call, shaped for the llm_calls table. */
export interface EmbeddingCallRecord {
  purpose: 'embed';
  promptVersion: string;
  model: string;
  request: { inputCount: number; inputTokensEstimated: number };
  response: unknown;
  latencyMs: number;
  inputTokens: number;
  outputTokens: 0;
  costUsd: number;
  error: string | null;
}

export interface EmbedOptions {
  /** Recorded as the model when the API response omits one. Defaults to OPENAI_MODEL_EMBED. */
  model?: string;
  /**
   * How the call is attributed. Embeddings have no prompt file, so this label is
   * what the cost breakdown groups by.
   */
  promptVersion?: string;
}

export interface EmbedOutcome {
  /** One vector per input, in input order. */
  vectors: number[][];
  calls: EmbeddingCallRecord[];
  /** Inputs skipped because they were empty after trimming. Counted, not embedded. */
  skippedEmpty: number;
}

export class EmbeddingDimensionError extends Error {
  constructor(
    readonly expected: number,
    readonly actual: number
  ) {
    super(
      `embedding model returned ${actual} dimensions but the schema declares ${expected}. ` +
        'Use text-embedding-3-small, or write a migration for the new width.'
    );
    this.name = 'EmbeddingDimensionError';
  }
}

/**
 * Thrown by `embedTexts` when a batch fails. The original error is the `cause`; the
 * point of the wrapper is `calls`, which holds every record made before the failure
 * *and* the failed one. A thrown error would otherwise take those records with it, and
 * a failed call that already spent tokens (a dimension mismatch is detected after the
 * response arrives) is still spend that belongs in llm_calls.
 */
export class EmbeddingCallError extends Error {
  constructor(
    cause: unknown,
    readonly calls: EmbeddingCallRecord[]
  ) {
    super(errorMessage(cause), { cause });
    this.name = 'EmbeddingCallError';
  }
}

interface PendingInput {
  /** Position in the caller's array, so output stays aligned with source rows. */
  index: number;
  text: string;
}

type BatchResult =
  | { ok: true; record: EmbeddingCallRecord; vectors: number[][] }
  | { ok: false; record: EmbeddingCallRecord; error: unknown };

/** Non-blank inputs, trimmed, split into request-sized batches. */
function planBatches(texts: readonly string[]): { batches: PendingInput[][]; pending: number } {
  const pending: PendingInput[] = [];
  texts.forEach((text, index) => {
    const trimmed = text.trim();
    // A very long input is truncated by the API itself; there is no ceiling to enforce
    // here the way the chat path enforces one, so only emptiness is filtered.
    if (trimmed === '') return;
    pending.push({ index, text: trimmed });
  });

  const batches: PendingInput[][] = [];
  for (let offset = 0; offset < pending.length; offset += EMBEDDING_BATCH_SIZE) {
    batches.push(pending.slice(offset, offset + EMBEDDING_BATCH_SIZE));
  }
  return { batches, pending: pending.length };
}

/**
 * Sends one batch. Never throws: the outcome is returned with its record either way,
 * so the strict and tolerant callers differ only in what they do with a failure.
 *
 * Vectors are returned only when every one in the batch passed the dimension check —
 * a batch is accepted or rejected whole, so a failure cannot leave some of its rows
 * holding vectors and others not.
 */
async function embedBatch(
  batch: readonly PendingInput[],
  model: string,
  promptVersion: string
): Promise<BatchResult> {
  const input = batch.map((item) => item.text);
  const startedAt = Date.now();
  const record: EmbeddingCallRecord = {
    purpose: 'embed',
    promptVersion,
    model,
    request: {
      inputCount: input.length,
      inputTokensEstimated: Math.ceil(input.join('').length / 4),
    },
    response: null,
    latencyMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    error: null,
  };

  try {
    const response = await withEmbeddingRetries(() =>
      getClient().embeddings.create({ model, input })
    );

    record.response = {
      model: response.model,
      usage: response.usage,
      dimensions: response.data[0]?.embedding.length ?? 0,
    };

    // Cost is recorded before validation: the tokens were spent even if the vectors
    // turn out to be unusable.
    const served = response.model || model;
    record.model = served;
    record.inputTokens = response.usage?.prompt_tokens ?? record.request.inputTokensEstimated;
    record.costUsd = costUsd(served, record.inputTokens, 0);

    const vectors: number[][] = batch.map(() => []);
    for (const item of response.data) {
      if (!batch[item.index]) continue;
      if (item.embedding.length !== EMBEDDING_DIMENSIONS) {
        throw new EmbeddingDimensionError(EMBEDDING_DIMENSIONS, item.embedding.length);
      }
      vectors[item.index] = item.embedding;
    }

    record.latencyMs = Date.now() - startedAt;
    return { ok: true, record, vectors };
  } catch (error) {
    record.error = errorMessage(error);
    record.latencyMs = Date.now() - startedAt;
    return { ok: false, record, error };
  }
}

/**
 * Embeds a batch of texts, preserving input order.
 *
 * Empty strings are not sent: the API rejects an empty input, and a blank
 * requirement has no vector worth storing. The caller gets the same-length output
 * array either way, with `[]` standing in for the skipped slots, so indices stay
 * aligned with the caller's source rows.
 *
 * Stops at the first failed batch and throws an `EmbeddingCallError` carrying every
 * call record so far, the failed one included, so the caller can still log them.
 */
export async function embedTexts(
  texts: readonly string[],
  options: EmbedOptions = {}
): Promise<EmbedOutcome> {
  const config = getConfig();
  const model = options.model ?? config.modelEmbed;
  const promptVersion = options.promptVersion ?? 'embedding-v1';
  const calls: EmbeddingCallRecord[] = [];

  const vectors: number[][] = texts.map(() => []);
  const { batches, pending } = planBatches(texts);

  for (const batch of batches) {
    const result = await embedBatch(batch, model, promptVersion);
    calls.push(result.record);
    if (!result.ok) throw new EmbeddingCallError(result.error, calls);
    batch.forEach((item, i) => {
      vectors[item.index] = result.vectors[i] ?? [];
    });
  }

  return {
    vectors,
    calls,
    skippedEmpty: texts.length - pending,
  };
}

/** Convenience for the single-text case, which is the read path's usual shape. */
export async function embedText(text: string, options: EmbedOptions = {}): Promise<number[]> {
  const { vectors } = await embedTexts([text], options);
  return vectors[0] ?? [];
}

export interface EmbedManyOutcome extends EmbedOutcome {
  /** Sum of every recorded call's cost, so a backfill can report one number. */
  totalCostUsd: number;
  totalInputTokens: number;
  /** Batches whose call failed. Their records, with `error` set, are in `calls`. */
  failedBatches: number;
  /** Caller-array positions of the inputs in failed batches. Their vectors are `[]`. */
  failedIndices: number[];
}

/**
 * Embeds a large set in batches without throwing on the first failure, for backfills
 * where one bad row should not abandon the other several thousand.
 *
 * Every batch is attempted. Rows whose batch failed keep `[]` and are listed in
 * `failedIndices`, and the failed call's record is in `calls` with its error, which
 * the caller records — the same posture as the analysis path, where a failed attempt
 * is a fact worth keeping.
 */
export async function embedTextsTolerant(
  texts: readonly string[],
  options: EmbedOptions = {}
): Promise<EmbedManyOutcome> {
  const config = getConfig();
  const model = options.model ?? config.modelEmbed;
  const promptVersion = options.promptVersion ?? 'embedding-v1';
  const calls: EmbeddingCallRecord[] = [];
  const failedIndices: number[] = [];
  let failedBatches = 0;

  const vectors: number[][] = texts.map(() => []);
  const { batches, pending } = planBatches(texts);

  for (const batch of batches) {
    const result = await embedBatch(batch, model, promptVersion);
    calls.push(result.record);
    if (!result.ok) {
      failedBatches += 1;
      failedIndices.push(...batch.map((item) => item.index));
      continue;
    }
    batch.forEach((item, i) => {
      vectors[item.index] = result.vectors[i] ?? [];
    });
  }

  return {
    vectors,
    calls,
    skippedEmpty: texts.length - pending,
    totalCostUsd: calls.reduce((sum, call) => sum + call.costUsd, 0),
    totalInputTokens: calls.reduce((sum, call) => sum + call.inputTokens, 0),
    failedBatches,
    failedIndices,
  };
}

const RETRYABLE_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504]);

/**
 * The same backoff shape as the chat path — 0.5s, 1s, 2s with ±25% jitter — written
 * again rather than shared, because openai.ts's loop is private to that module and
 * widening its visibility to reuse six lines is not a trade worth making.
 */
async function withEmbeddingRetries<T>(fn: () => Promise<T>): Promise<T> {
  const { maxTransportRetries } = getConfig();
  let attempt = 0;

  for (;;) {
    try {
      return await fn();
    } catch (error) {
      const status = (error as { status?: number }).status;
      const retryable = status === undefined || RETRYABLE_STATUSES.has(status);
      if (!retryable || attempt >= maxTransportRetries) throw error;

      attempt += 1;
      const base = 500 * 2 ** (attempt - 1);
      const jitter = base * 0.25 * (Math.random() * 2 - 1);
      await new Promise((resolve) => setTimeout(resolve, base + jitter));
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Cosine similarity, for the in-process comparisons the fuzzy-coverage view makes
 * before it decides whether a query is worth sending to Postgres.
 *
 * Text-embedding-3 vectors are already unit-normalized, so this is a dot product in
 * practice; the norms are kept because relying on that undocumented property would
 * make a model swap silently change every score.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dot / denominator;
}

/**
 * pgvector's text input format: `[0.1,0.2,...]`. Returns null for an empty vector so
 * a caller cannot accidentally store a zero-width embedding, which the column would
 * reject anyway.
 */
export function toVectorLiteral(vector: readonly number[]): string | null {
  if (vector.length === 0) return null;
  return `[${vector.join(',')}]`;
}
