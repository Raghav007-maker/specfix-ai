/**
 * Configuration. Read once, validated, then treated as immutable.
 *
 * Model ids live here rather than in code so that moving the judgment pass to a
 * larger model is an environment change, not a deploy of new logic.
 */
import { z } from 'zod';
import 'dotenv/config';

const ConfigSchema = z.object({
  openaiApiKey: z.string().min(1, 'OPENAI_API_KEY is required'),
  openaiBaseUrl: z.string().url().optional(),
  modelExtract: z.string().min(1),
  modelJudge: z.string().min(1),
  /** Spec Compiler model. Separate from the judgment pass so Phase 2 spend is attributable. */
  modelCompile: z.string().min(1),
  /** Embedding model. `text-embedding-3-small` per the plan: pgvector is fine under ~1M vectors. */
  modelEmbed: z.string().min(1),
  temperature: z.number().min(0).max(2),
  /** Null disables seeding. Set it in any run whose numbers you intend to compare. */
  seed: z.number().int().nullable(),
  maxTicketInputTokens: z.number().int().positive(),
  requestTimeoutMs: z.number().int().positive(),
  maxTransportRetries: z.number().int().min(0),
});

export type Config = z.infer<typeof ConfigSchema>;

let cached: Config | undefined;

export function getConfig(): Config {
  if (cached) return cached;

  const parsed = ConfigSchema.safeParse({
    openaiApiKey: process.env.OPENAI_API_KEY ?? '',
    openaiBaseUrl: process.env.OPENAI_BASE_URL?.trim() || undefined,
    modelExtract: process.env.OPENAI_MODEL_EXTRACT ?? 'gpt-4o-mini',
    modelJudge: process.env.OPENAI_MODEL_JUDGE ?? 'gpt-4o-mini',
    modelCompile: process.env.OPENAI_MODEL_COMPILE ?? 'gpt-4o-mini',
    modelEmbed: process.env.OPENAI_MODEL_EMBED ?? 'text-embedding-3-small',
    temperature: Number(process.env.OPENAI_TEMPERATURE ?? 0),
    seed: process.env.OPENAI_SEED ? Number(process.env.OPENAI_SEED) : null,
    maxTicketInputTokens: Number(process.env.MAX_TICKET_INPUT_TOKENS ?? 8000),
    requestTimeoutMs: Number(process.env.OPENAI_TIMEOUT_MS ?? 120_000),
    maxTransportRetries: Number(process.env.OPENAI_MAX_RETRIES ?? 3),
  });

  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${issues}\n\nCheck your .env against .env.example.`);
  }

  cached = parsed.data;
  return cached;
}

/** Tests and the eval CLI use this after mutating process.env. */
export function resetConfigCache(): void {
  cached = undefined;
}

/** True when an API key is present, so integration tests can skip instead of fail. */
export function hasOpenAiCredentials(): boolean {
  return Boolean(process.env.OPENAI_API_KEY);
}
