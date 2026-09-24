/**
 * Critic pass schemas.
 *
 * The Critic reviews the Extractor's candidate flags and returns one verdict per
 * candidate. It does not return flags of its own, and it is not permitted to
 * invent, merge, or re-categorize them — see the enforcement in
 * packages/core/src/deliberate.ts, which takes only `verdict`,
 * `refined_question_for_pm` and `refined_severity` from this payload and ignores
 * anything else the model tries to change.
 *
 * Candidates are addressed by index rather than by quoting them back, because a
 * model asked to repeat a quoted span will eventually paraphrase it, and a
 * paraphrase silently breaks the join back to the Extractor's grounded flag.
 */
import { z } from 'zod';
import { SeveritySchema } from './flags.ts';

export const CRITIC_VERDICTS = ['keep', 'prune'] as const;
export const CriticVerdictSchema = z.enum(CRITIC_VERDICTS);
export type CriticVerdict = z.infer<typeof CriticVerdictSchema>;

export const CriticReviewSchema = z
  .object({
    /** Zero-based index into the candidate list as it was presented. */
    candidate_index: z.number().int().min(0),
    verdict: CriticVerdictSchema,
    /** Why this candidate survived or was dropped. Recorded either way — a prune with no stated reason is not auditable. */
    reason: z.string().min(1),
    /** Rewritten PM question for a kept candidate. Empty string when pruning. */
    refined_question_for_pm: z.string(),
    refined_severity: SeveritySchema,
  })
  .strict();
export type CriticReview = z.infer<typeof CriticReviewSchema>;

export const CriticResultSchema = z
  .object({
    /**
     * One review per candidate. The array is capped above the Extractor's own
     * 30-flag ceiling so that a model which duplicates an index fails
     * deduplication in code rather than schema validation, which would waste the
     * call.
     */
    reviews: z.array(CriticReviewSchema).max(60),
  })
  .strict();
export type CriticResult = z.infer<typeof CriticResultSchema>;
