/**
 * JSON Schema for OpenAI structured outputs, in strict mode.
 *
 * Kept as an explicit object rather than generated from zod, because strict mode
 * has requirements a generic converter gets wrong: every property must be listed in
 * `required`, `additionalProperties` must be false at every level, and optional
 * fields are not supported at all.
 *
 * Enum values are derived from the shared constants so they cannot drift. The
 * property lists are guarded by the drift-guard tests in packages/core/test —
 * `core.test.ts` for the analysis schema, `deliberate.test.ts` for the critic
 * schema — each comparing the hand-written JSON Schema against the zod keys.
 */
import {
  CRITIC_VERDICTS,
  FLAG_CATEGORIES,
  SEVERITIES,
  type CriticReviewSchema,
  type LlmFlagSchema,
} from '@specfix/shared';

export const ANALYSIS_SCHEMA_NAME = 'requirement_analysis';
export const CRITIC_SCHEMA_NAME = 'candidate_review';

export const FLAG_PROPERTY_ORDER = [
  'category',
  'quoted_span',
  'what_unclear',
  'why_it_matters',
  'question_for_pm',
  'severity',
] as const satisfies readonly (keyof typeof LlmFlagSchema.shape)[];

export function buildAnalysisJsonSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['flags'],
    properties: {
      flags: {
        type: 'array',
        description:
          'One entry per genuine gap. Empty when the requirement is unambiguous ' +
          'enough to implement without guessing.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: [...FLAG_PROPERTY_ORDER],
          properties: {
            category: { type: 'string', enum: [...FLAG_CATEGORIES] },
            quoted_span: {
              type: 'string',
              description:
                'Exact substring of the ticket this is about, character-for-character. ' +
                'Empty string when the gap is an absence with nothing to quote.',
            },
            what_unclear: { type: 'string' },
            why_it_matters: { type: 'string' },
            question_for_pm: { type: 'string' },
            severity: { type: 'string', enum: [...SEVERITIES] },
          },
        },
      },
    },
  };
}

export function responseFormat(): {
  type: 'json_schema';
  json_schema: { name: string; strict: true; schema: Record<string, unknown> };
} {
  return jsonSchemaFormat(ANALYSIS_SCHEMA_NAME, buildAnalysisJsonSchema());
}

export const CRITIC_REVIEW_PROPERTY_ORDER = [
  'candidate_index',
  'verdict',
  'reason',
  'refined_question_for_pm',
  'refined_severity',
] as const satisfies readonly (keyof typeof CriticReviewSchema.shape)[];

/**
 * The Critic's structured output: one verdict per candidate, addressed by index.
 *
 * `candidate_index` is an integer rather than a repeated quote because a model
 * asked to echo a span back will eventually paraphrase it, and a paraphrase breaks
 * the join to the Extractor's grounded flag without failing validation.
 */
export function buildCriticJsonSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['reviews'],
    properties: {
      reviews: {
        type: 'array',
        description:
          'Exactly one review per candidate supplied, in any order. No reviews for ' +
          'indices that were not supplied.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: [...CRITIC_REVIEW_PROPERTY_ORDER],
          properties: {
            candidate_index: {
              type: 'integer',
              description: "The candidate's own `index` value, copied exactly.",
            },
            verdict: { type: 'string', enum: [...CRITIC_VERDICTS] },
            reason: {
              type: 'string',
              description:
                'One sentence. For a prune, which test it failed. For a keep, the ' +
                'decision the developer would otherwise guess. Written to an audit log.',
            },
            refined_question_for_pm: {
              type: 'string',
              description: 'Rewritten question for a kept candidate. Empty string for a prune.',
            },
            refined_severity: { type: 'string', enum: [...SEVERITIES] },
          },
        },
      },
    },
  };
}

export function criticResponseFormat(): ReturnType<typeof responseFormat> {
  return jsonSchemaFormat(CRITIC_SCHEMA_NAME, buildCriticJsonSchema());
}

function jsonSchemaFormat(
  name: string,
  schema: Record<string, unknown>
): {
  type: 'json_schema';
  json_schema: { name: string; strict: true; schema: Record<string, unknown> };
} {
  return {
    type: 'json_schema',
    json_schema: { name, strict: true, schema },
  };
}
