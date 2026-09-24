/**
 * Flag taxonomy and schemas.
 *
 * These six categories are fixed by the Phase 1 plan. Adding a category is a
 * prompt change *and* a migration *and* an eval re-baseline, so it is not a
 * casual edit — the per-category precision breakdown in the eval report is keyed
 * on this list.
 */
import { z } from 'zod';

export const FLAG_CATEGORIES = [
  'missing_info',
  'vague_language',
  'contradiction',
  'edge_case',
  'security_compliance',
  'untestable',
] as const;

export const FlagCategorySchema = z.enum(FLAG_CATEGORIES);
export type FlagCategory = z.infer<typeof FlagCategorySchema>;

export const FLAG_CATEGORY_LABELS: Record<FlagCategory, string> = {
  missing_info: 'Missing information',
  vague_language: 'Vague language',
  contradiction: 'Contradiction',
  edge_case: 'Unhandled edge case',
  security_compliance: 'Security / compliance gap',
  untestable: 'Untestable criterion',
};

export const SEVERITIES = ['low', 'medium', 'high'] as const;
export const SeveritySchema = z.enum(SEVERITIES);
export type Severity = z.infer<typeof SeveritySchema>;

/**
 * Flag lifecycle.
 *
 * `stale` exists because a ticket can be edited after its flags were resolved.
 * Resolved flags belong to a specific ticket_version; when a newer version
 * arrives the old ones are marked stale rather than silently carried forward or
 * lost. See packages/db/migrations/0001_init.sql.
 *
 * `pruned` is the Adversarial Critic's rejection. It is deliberately distinct from
 * `dismissed`: dismissed means a human read the question and judged it noise, which
 * is evidence about the model; pruned means the second model pass filtered it before
 * a human ever saw it, which is evidence about the Critic. Collapsing the two would
 * let the Critic's own prunes count as human dismissals and make its precision
 * unfalsifiable. Pruned flags are stored, hidden from the review queue, and read back
 * by the random-pruning control.
 */
export const FLAG_STATUSES = [
  'open',
  'accepted',
  'edited',
  'dismissed',
  'stale',
  'pruned',
] as const;
export const FlagStatusSchema = z.enum(FLAG_STATUSES);
export type FlagStatus = z.infer<typeof FlagStatusSchema>;

export const REVIEW_DECISIONS = ['accepted', 'edited', 'dismissed', 'reopened'] as const;
export const ReviewDecisionSchema = z.enum(REVIEW_DECISIONS);
export type ReviewDecision = z.infer<typeof ReviewDecisionSchema>;

/**
 * Where a flag came from.
 *
 * This exists to keep one number honest. Precision answers "of the gaps the
 * *model* raised, how many were real?" A question a developer typed is real by
 * construction — a human chose to ask it — so counting developer-origin rows in
 * the precision denominator inflates the metric for free, and the inflation grows
 * with adoption.
 *
 * Every precision computation filters on `ai_agent`. See `scoreRun` in
 * packages/eval/src/score.ts and the test that guards it. This constant exists
 * now, ahead of the developer-query feature, precisely so that feature cannot
 * arrive and quietly change what precision means.
 */
export const FLAG_ORIGINS = ['ai_agent', 'developer'] as const;
export const FlagOriginSchema = z.enum(FLAG_ORIGINS);
export type FlagOrigin = z.infer<typeof FlagOriginSchema>;

/** The only origin that may enter a precision denominator. */
export const AI_ORIGIN: FlagOrigin = 'ai_agent';

/**
 * A flag exactly as the model is required to return it.
 *
 * Every field is required and non-empty on purpose: OpenAI structured outputs in
 * strict mode does not support optional properties, and a flag missing its
 * `question_for_pm` is useless to a reviewer anyway.
 */
export const LlmFlagSchema = z
  .object({
    category: FlagCategorySchema,
    /** Verbatim substring of the ticket this flag is about, or "" when it is about an absence. */
    quoted_span: z.string(),
    what_unclear: z.string().min(1),
    why_it_matters: z.string().min(1),
    question_for_pm: z.string().min(1),
    severity: SeveritySchema,
  })
  .strict();
export type LlmFlag = z.infer<typeof LlmFlagSchema>;

/** The full analysis payload the model must return. */
export const AnalysisResultSchema = z
  .object({
    flags: z.array(LlmFlagSchema).max(30),
  })
  .strict();
export type AnalysisResult = z.infer<typeof AnalysisResultSchema>;

/** A flag after persistence, as the dashboard and eval harness see it. */
export const FlagSchema = LlmFlagSchema.extend({
  id: z.string(),
  ticket_id: z.string(),
  ticket_version_id: z.string(),
  analysis_run_id: z.string(),
  /**
   * Defaults to `ai_agent` so existing model-produced rows keep their meaning.
   * A developer-raised query sets this explicitly and is thereby excluded from
   * precision.
   */
  origin: FlagOriginSchema.default(AI_ORIGIN),
  status: FlagStatusSchema,
  dedupe_key: z.string(),
  edited_question: z.string().nullable(),
});
export type Flag = z.infer<typeof FlagSchema>;

/**
 * Precision counts a flag as a real issue when the reviewer accepted it, with or
 * without editing the wording. Dismissed means noise. Anything still open, stale or
 * pruned is not yet evidence either way and is excluded from the denominator — a
 * pruned flag in particular has no human verdict at all, only the Critic's.
 */
export function isRealIssue(status: FlagStatus): boolean {
  return status === 'accepted' || status === 'edited';
}

export function isReviewed(status: FlagStatus): boolean {
  return status === 'accepted' || status === 'edited' || status === 'dismissed';
}
