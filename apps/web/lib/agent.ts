import 'server-only';

/**
 * The resolution agent's feature flag. The Phase 2 plan ships the agent behind a flag,
 * off by default, as an alternative to the form rather than a replacement — so with the
 * flag off the Conversation tab does not exist and nothing else changes.
 *
 *   SPECFIX_RESOLUTION_AGENT=on
 */
export function resolutionAgentEnabled(): boolean {
  return process.env.SPECFIX_RESOLUTION_AGENT?.trim().toLowerCase() === 'on';
}
