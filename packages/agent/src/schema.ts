/**
 * JSON Schema for the agent's structured output, in OpenAI strict mode.
 *
 * Same reasoning as packages/core/src/schema.ts: an explicit object rather than one
 * generated from zod, because strict mode needs every property in `required`,
 * `additionalProperties: false` at every level and no optional fields. "No proposal
 * yet" is a null, expressed as an `anyOf` with the null type. The property lists are
 * guarded by a drift test in packages/agent/test.
 */
import {
  AGENT_PROPOSAL_DECISIONS,
  type AgentProposalSchema,
  type AgentTurnResultSchema,
} from '@specfix/shared';

export const AGENT_SCHEMA_NAME = 'agent_turn';

export const TURN_PROPERTY_ORDER = [
  'reply',
  'proposal',
] as const satisfies readonly (keyof typeof AgentTurnResultSchema.shape)[];

export const PROPOSAL_PROPERTY_ORDER = [
  'decision',
  'edited_question',
  'resolution_note',
] as const satisfies readonly (keyof typeof AgentProposalSchema.shape)[];

export function buildAgentJsonSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: [...TURN_PROPERTY_ORDER],
    properties: {
      reply: {
        type: 'string',
        description: 'What you say to the PM. Plain text, two or three sentences.',
      },
      proposal: {
        description:
          'The drafted decision, only once the PM has settled the question in their own ' +
          'words. Null otherwise.',
        anyOf: [
          {
            type: 'object',
            additionalProperties: false,
            required: [...PROPOSAL_PROPERTY_ORDER],
            properties: {
              decision: { type: 'string', enum: [...AGENT_PROPOSAL_DECISIONS] },
              edited_question: {
                type: 'string',
                description: 'The reworded question for an edited proposal; empty otherwise.',
              },
              resolution_note: {
                type: 'string',
                description:
                  "The PM's answer as a buildable requirement, or why the flag is dismissed.",
              },
            },
          },
          { type: 'null' },
        ],
      },
    },
  };
}

export function agentResponseFormat(): {
  type: 'json_schema';
  json_schema: { name: string; strict: true; schema: Record<string, unknown> };
} {
  return {
    type: 'json_schema',
    json_schema: { name: AGENT_SCHEMA_NAME, strict: true, schema: buildAgentJsonSchema() },
  };
}
