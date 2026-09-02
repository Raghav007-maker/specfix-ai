/**
 * OpenAI transport.
 *
 * Two distinct failure classes, handled differently on purpose:
 *
 *  - transport failures (429, 5xx, timeouts) — retried with exponential backoff
 *    and jitter, because they are transient and retrying is correct
 *  - schema failures (the model returned something that does not validate) — one
 *    corrective retry, then give up and surface it. Retrying a schema failure many
 *    times mostly burns money; a persistent one is a prompt bug and should be
 *    visible as a failed run, not smoothed over.
 */
import OpenAI from 'openai';
import type { ChatCompletion, ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { AnalysisResultSchema, type AnalysisResult } from '@specfix/shared';
import { getConfig } from './config.ts';
import { responseFormat } from './schema.ts';
import { costUsd } from './cost.ts';

let client: OpenAI | undefined;

export function getClient(): OpenAI {
  if (!client) {
    const config = getConfig();
    client = new OpenAI({
      apiKey: config.openaiApiKey,
      timeout: config.requestTimeoutMs,
      // Retries are handled here, not by the SDK, so every attempt is logged.
      maxRetries: 0,
    });
  }
  return client;
}

export function resetClient(): void {
  client = undefined;
}

/** One recorded call, ready to be written to the llm_calls table. */
export interface LlmCallRecord {
  purpose: 'extract' | 'judge' | 'single_shot';
  promptVersion: string;
  model: string;
  request: { messages: ChatCompletionMessageParam[]; temperature: number; seed: number | null };
  response: unknown;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  error: string | null;
}

export class SchemaValidationError extends Error {
  constructor(
    message: string,
    readonly rawContent: string
  ) {
    super(message);
    this.name = 'SchemaValidationError';
  }
}

export interface StructuredCallOptions {
  purpose: LlmCallRecord['purpose'];
  promptVersion: string;
  model: string;
  systemMessage: string;
  userMessage: string;
}

export interface StructuredCallOutcome {
  result: AnalysisResult;
  calls: LlmCallRecord[];
}

/**
 * Sends one analysis request and returns validated output.
 *
 * `calls` contains every attempt, failures included. Callers persist all of them —
 * a run that succeeded on the second attempt is a fact worth keeping when
 * comparing prompt versions.
 */
export async function callForAnalysis(
  options: StructuredCallOptions
): Promise<StructuredCallOutcome> {
  const config = getConfig();
  const calls: LlmCallRecord[] = [];

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: options.systemMessage },
    { role: 'user', content: options.userMessage },
  ];

  let schemaRepairUsed = false;

  for (;;) {
    const completion = await withTransportRetries(() =>
      getClient().chat.completions.create({
        model: options.model,
        messages,
        temperature: config.temperature,
        ...(config.seed === null ? {} : { seed: config.seed }),
        response_format: responseFormat(),
      })
    );

    const record = toRecord(options, messages, config, completion);
    calls.push(record);

    const content = completion.choices[0]?.message?.content ?? '';
    const validated = validate(content);

    if (validated.ok) {
      return { result: validated.value, calls };
    }

    record.error = validated.error;

    if (schemaRepairUsed) {
      throw new SchemaValidationError(
        `model output failed schema validation twice: ${validated.error}`,
        content
      );
    }

    // One corrective attempt. The model's own bad output is included as an
    // assistant turn so it can see what it did.
    schemaRepairUsed = true;
    messages.push(
      { role: 'assistant', content },
      {
        role: 'user',
        content:
          'That response did not satisfy the required schema. ' +
          `Error: ${validated.error}. Return only the structured object.`,
      }
    );
  }
}

function validate(
  content: string
): { ok: true; value: AnalysisResult } | { ok: false; error: string } {
  if (content.trim() === '') {
    return { ok: false, error: 'empty response content' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    return { ok: false, error: `not valid JSON: ${message(error)}` };
  }
  const result = AnalysisResultSchema.safeParse(parsed);
  return result.success
    ? { ok: true, value: result.data }
    : {
        ok: false,
        error: result.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; '),
      };
}

function toRecord(
  options: StructuredCallOptions,
  messages: ChatCompletionMessageParam[],
  config: ReturnType<typeof getConfig>,
  completion: ChatCompletion & { _latencyMs?: number }
): LlmCallRecord {
  const inputTokens = completion.usage?.prompt_tokens ?? 0;
  const outputTokens = completion.usage?.completion_tokens ?? 0;
  return {
    purpose: options.purpose,
    promptVersion: options.promptVersion,
    model: completion.model || options.model,
    request: {
      messages: [...messages],
      temperature: config.temperature,
      seed: config.seed,
    },
    response: completion,
    latencyMs: completion._latencyMs ?? 0,
    inputTokens,
    outputTokens,
    costUsd: costUsd(completion.model || options.model, inputTokens, outputTokens),
    error: null,
  };
}

const RETRYABLE_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504]);

async function withTransportRetries<T extends object>(fn: () => Promise<T>): Promise<T> {
  const { maxTransportRetries } = getConfig();
  let attempt = 0;

  for (;;) {
    const startedAt = Date.now();
    try {
      const result = await fn();
      Object.defineProperty(result, '_latencyMs', {
        value: Date.now() - startedAt,
        enumerable: false,
      });
      return result;
    } catch (error) {
      const status = (error as { status?: number }).status;
      const retryable = status === undefined || RETRYABLE_STATUSES.has(status);

      if (!retryable || attempt >= maxTransportRetries) {
        throw error;
      }
      attempt += 1;
      // Exponential backoff with jitter: 0.5s, 1s, 2s, each ±25%.
      const base = 500 * 2 ** (attempt - 1);
      const jitter = base * 0.25 * (Math.random() * 2 - 1);
      await sleep(base + jitter);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
