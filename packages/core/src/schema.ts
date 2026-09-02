/**
 * JSON Schema for OpenAI structured outputs, in strict mode.
 *
 * Kept as an explicit object rather than generated from zod, because strict mode
 * has requirements a generic converter gets wrong: every property must be listed in
 * `required`, `additionalProperties` must be false at every level, and optional
 * fields are not supported at all.
 *
 * Enum values are derived from the shared constants so they cannot drift. The
 * property list is guarded by packages/core/test/schema.test.ts, which compares it
 * against the zod schema's keys.
 */
import { FLAG_CATEGORIES, SEVERITIES, type LlmFlagSchema } from '@specfix/shared';

export const ANALYSIS_SCHEMA_NAME = 'requirement_analysis';

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
  return {
    type: 'json_schema',
    json_schema: {
      name: ANALYSIS_SCHEMA_NAME,
      strict: true,
      schema: buildAnalysisJsonSchema(),
    },
  };
}
