/**
 * JSON Schema for the Spec Compiler's structured output, in OpenAI strict mode.
 *
 * Same reasoning as packages/core/src/schema.ts: kept as an explicit object rather
 * than generated from zod, because strict mode requires every property in `required`,
 * `additionalProperties: false` at every level, and no optional fields at all. Enum
 * values come from the shared constants so they cannot drift, and the property lists
 * are guarded by a drift test in packages/compiler/test.
 */
import { GHERKIN_KEYWORDS } from '@specfix/shared';
import type { LlmScenarioSchema } from '@specfix/shared';

export const GHERKIN_SCHEMA_NAME = 'gherkin_scenarios';

export const STEP_PROPERTY_ORDER = ['keyword', 'text'] as const;

export const SCENARIO_PROPERTY_ORDER = [
  'title',
  'steps',
  'covers_ac',
  'rationale',
  'source_flag_indexes',
] as const satisfies readonly (keyof typeof LlmScenarioSchema.shape)[];

export function buildGherkinJsonSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['scenarios'],
    properties: {
      scenarios: {
        type: 'array',
        description:
          'One entry per distinct testable behaviour in the approved acceptance ' +
          'criteria. Empty when the criteria are not yet specific enough to test.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: [...SCENARIO_PROPERTY_ORDER],
          properties: {
            title: {
              type: 'string',
              description:
                'One line naming the behaviour under test, in the third person, as a ' +
                'Gherkin scenario name. Not a restatement of the ticket title.',
            },
            steps: {
              type: 'array',
              minItems: 1,
              maxItems: 20,
              items: {
                type: 'object',
                additionalProperties: false,
                required: [...STEP_PROPERTY_ORDER],
                properties: {
                  keyword: { type: 'string', enum: [...GHERKIN_KEYWORDS] },
                  text: {
                    type: 'string',
                    description:
                      'The step body without the keyword. Concrete and observable: a ' +
                      'value, an action, or an outcome a test could assert. No ' +
                      'implementation detail (selectors, function names, HTTP verbs).',
                  },
                },
              },
            },
            covers_ac: {
              type: 'string',
              description:
                'Exact substring of the acceptance criteria this scenario covers, ' +
                'character-for-character. Empty string when the scenario is derived ' +
                'rather than quoting a single clause. Never paraphrase into this field.',
            },
            rationale: {
              type: 'string',
              description:
                'One sentence: which acceptance criterion or resolved decision this ' +
                'scenario exercises. Written to an audit log.',
            },
            source_flag_indexes: {
              type: 'array',
              description:
                'Zero-based indexes of the resolved flags (from the supplied list) ' +
                'whose answers this scenario encodes. Empty when none apply.',
              items: { type: 'integer', minimum: 0 },
            },
          },
        },
      },
    },
  };
}

export function gherkinResponseFormat(): {
  type: 'json_schema';
  json_schema: { name: string; strict: true; schema: Record<string, unknown> };
} {
  return {
    type: 'json_schema',
    json_schema: { name: GHERKIN_SCHEMA_NAME, strict: true, schema: buildGherkinJsonSchema() },
  };
}
