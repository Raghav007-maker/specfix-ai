/**
 * Conversational resolution agent schemas (Phase 2, Milestone F).
 *
 * The agent is an alternative UI to the flag review form, not a second decision path.
 * It asks the PM one flagged question at a time, and when the PM has answered it may
 * *propose* the decision the form would have recorded — accept with the PM's answer as
 * the resolution, edit the question, or dismiss. A proposal is inert: nothing changes
 * until a person applies it, and applying it goes through the same `decideFlag` the
 * form posts to. That is why the proposal's decision set is the form's, minus
 * `reopened` (the agent only ever works on open flags).
 */
import { z } from 'zod';

export const AGENT_PROPOSAL_DECISIONS = ['accepted', 'edited', 'dismissed'] as const;
export const AgentProposalDecisionSchema = z.enum(AGENT_PROPOSAL_DECISIONS);
export type AgentProposalDecision = z.infer<typeof AgentProposalDecisionSchema>;

/** Longest PM message the agent accepts. Long enough for a pasted clause, short enough to bound a turn's cost. */
export const AGENT_MESSAGE_MAX_CHARS = 2000;
/** Ceilings on what the model may return, so a runaway reply cannot reach the DB or the UI. */
export const AGENT_REPLY_MAX_CHARS = 2000;
export const AGENT_RESOLUTION_MAX_CHARS = 2000;

export const AgentProposalSchema = z
  .object({
    decision: AgentProposalDecisionSchema,
    /** The rewritten question for an `edited` proposal. Empty string otherwise. */
    edited_question: z.string().max(AGENT_RESOLUTION_MAX_CHARS),
    /**
     * The PM's answer written as the disambiguated requirement: what the ticket now
     * means. Stored as the decision's resolution note, which is what the Spec Compiler
     * conditions on. For a dismissal, why the flag is not a real gap.
     */
    resolution_note: z.string().max(AGENT_RESOLUTION_MAX_CHARS),
  })
  .strict();
export type AgentProposal = z.infer<typeof AgentProposalSchema>;

export const AgentTurnResultSchema = z
  .object({
    /** What the agent says back to the PM. Plain text, trimmed before the emptiness check. */
    reply: z.string().trim().min(1).max(AGENT_REPLY_MAX_CHARS),
    /** Null until the PM has actually answered the question. */
    proposal: AgentProposalSchema.nullable(),
  })
  .strict();
export type AgentTurnResult = z.infer<typeof AgentTurnResultSchema>;

/**
 * Normalizes a PM's chat message, or says why it cannot be sent. Shared by the server
 * action and its tests so the rule is stated once: whitespace-only is empty, and the
 * length cap is measured after trimming.
 */
export function normalizeAgentMessage(
  raw: unknown
): { ok: true; text: string } | { ok: false; error: string } {
  const text = typeof raw === 'string' ? raw.replace(/\r\n/g, '\n').trim() : '';
  if (text === '') return { ok: false, error: 'Write a message before sending.' };
  if (text.length > AGENT_MESSAGE_MAX_CHARS) {
    return {
      ok: false,
      error: `Keep your message under ${AGENT_MESSAGE_MAX_CHARS} characters (it is ${text.length}).`,
    };
  }
  return { ok: true, text };
}
