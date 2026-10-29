'use server';

/**
 * The Specs tab's writes: generate scenarios from the approved requirement, and
 * accept / edit / dismiss each generated scenario.
 *
 * Same two rules as the flag-review actions. The tenant is resolved from the signed-in
 * user's membership, never from the form, so a posted ticketId from another tenant
 * resolves to nothing and is bounced. And the repository layer owns the business rules
 * (an edit needs replacement text; a scenario on a superseded version cannot be
 * decided); these actions surface the resulting message rather than restating them.
 *
 * Generation runs inline here because there is no worker yet. It is the one action that
 * reaches past the repositories into the Spec Compiler (an LLM call), so it is guarded
 * by the same gates the plan requires: the version must be marked ready, and the
 * workspace must be under its monthly token cap.
 */
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  SCENARIO_REVIEW_DECISIONS,
  isApprovedScenario,
  parseGherkin,
  type ScenarioReviewDecision,
} from '@specfix/shared';
import { compileScenarios, emitPlaywrightScaffold } from '@specfix/compiler';
import { GithubAuthError, GithubHttpError } from '@specfix/ingest';
import { PermanentJobError, openScaffoldPr } from '@specfix/sync';
import { refreshScenarioEmbedding } from '@/lib/embeddings';
import { requireUser } from '@/lib/session';
import { requireTenant } from '@/lib/tenant';
import {
  GithubConnectionError,
  ScenarioDecisionError,
  decideScaffold,
  decideScenario,
  getScenario,
  getTicket,
  isOverTokenCap,
  latestVersion,
  listReadinessEvents,
  recordCompilation,
  resolvedFlagsForVersion,
  saveScaffold,
} from '@/lib/repos';

/** A refusal these actions word for the reviewer themselves. */
class ActionError extends Error {}

interface Context {
  userId: string;
  tenantId: string;
  ticketId: string;
}

async function context(formData: FormData): Promise<Context> {
  const posted = String(formData.get('ticketId') ?? '');
  const user = await requireUser();
  const tenant = await requireTenant(user.id);

  const ticket = await getTicket(tenant.tenant_id, posted);
  if (!ticket) redirect('/');

  return { userId: user.id, tenantId: tenant.tenant_id, ticketId: ticket.id };
}

/** As the Review tab's settle: reviewer-worded refusals are shown, anything else is logged. */
async function settle(ticketId: string, work: () => Promise<void>): Promise<never> {
  let message: string | null = null;
  try {
    await work();
  } catch (error) {
    if (error instanceof ActionError || error instanceof ScenarioDecisionError) {
      message = error.message;
    } else {
      console.error('[specs] action failed', error);
      message = 'That did not work. Reload the page and try again.';
    }
  }

  revalidatePath(`/tickets/${ticketId}/specs`);
  redirect(
    message
      ? `/tickets/${ticketId}/specs?error=${encodeURIComponent(message)}`
      : `/tickets/${ticketId}/specs`
  );
}

/**
 * Compile Gherkin scenarios from the current version's approved requirement.
 *
 * The gate is the plan's: generation keys off SpecFix's own approved state — a version
 * that is marked ready (which `markReady` only allows once every flag is resolved),
 * with its acceptance criteria as the disambiguated requirement and the resolved flags
 * as the clarifications. Re-running is safe: `recordCompilation` skips scenarios whose
 * dedupe key already exists, so decisions already made are preserved.
 */
export async function generateScenarios(formData: FormData): Promise<void> {
  const ctx = await context(formData);
  await settle(ctx.ticketId, async () => {
    const ticket = await getTicket(ctx.tenantId, ctx.ticketId);
    if (!ticket) throw new ActionError('Ticket not found.');

    const version = await latestVersion(ctx.tenantId, ctx.ticketId);
    if (!version) throw new ActionError('This ticket has no analyzable version yet.');

    const events = await listReadinessEvents(ctx.tenantId, ctx.ticketId);
    const ready = events.some(
      (e) => e.event === 'marked_ready' && e.ticket_version_id === version.id
    );
    if (!ready) {
      throw new ActionError(
        'Mark this ticket ready for development first — generation compiles from the approved requirement, so every flag has to be resolved and the ticket signed off.'
      );
    }

    if (!version.acceptance_criteria_text.trim()) {
      throw new ActionError('This version has no acceptance criteria to compile scenarios from.');
    }

    if (await isOverTokenCap(ctx.tenantId)) {
      throw new ActionError(
        'This workspace is over its monthly token cap, so generation is paused until the cap resets.'
      );
    }

    const resolvedFlags = await resolvedFlagsForVersion(ctx.tenantId, version.id);

    const outcome = await compileScenarios({
      externalKey: ticket.external_key,
      title: version.title,
      acceptanceCriteriaText: version.acceptance_criteria_text,
      resolvedFlags,
    });

    await recordCompilation(ctx.tenantId, {
      ticketId: ctx.ticketId,
      ticketVersionId: version.id,
      meta: {
        promptVersion: outcome.meta.promptVersion,
        model: outcome.meta.model,
        temperature: outcome.meta.temperature,
        seed: outcome.meta.seed,
        truncated: outcome.meta.truncated,
        inputTokens: outcome.meta.inputTokens,
        outputTokens: outcome.meta.outputTokens,
        costUsd: outcome.meta.costUsd,
      },
      scenarios: outcome.scenarios,
      calls: outcome.calls.map((call) => ({
        purpose: 'compile_gherkin' as const,
        promptVersion: call.promptVersion,
        model: call.model,
        request: call.request,
        response: call.response,
        latencyMs: call.latencyMs,
        inputTokens: call.inputTokens,
        outputTokens: call.outputTokens,
        costUsd: call.costUsd,
        error: call.error,
      })),
    });
  });
}

/**
 * Accept / edit / dismiss / reopen a generated scenario. The human gate before scaffolds.
 *
 * An approve or edit then refreshes the scenario's embedding, so coverage reflects the
 * reviewed wording. That happens after the decision commits and cannot undo it: the
 * reviewer's verdict is the primary record and a vector is derived from it. If the
 * refresh does not succeed, the action reports that the decision was saved and what
 * happened to the embedding — through the same error banner as any other failure, so a
 * partial result is never shown as a clean one. Dismiss and reopen embed nothing; the
 * coverage queries only count approved and edited scenarios.
 */
export async function decideScenarioAction(formData: FormData): Promise<void> {
  const ctx = await context(formData);
  const scenarioId = String(formData.get('scenarioId') ?? '');
  const decision = String(formData.get('decision') ?? '');
  const editedText = String(formData.get('editedText') ?? '').trim();
  const resolutionNote = String(formData.get('resolutionNote') ?? '').trim();

  await settle(ctx.ticketId, async () => {
    if (!SCENARIO_REVIEW_DECISIONS.includes(decision as ScenarioReviewDecision)) {
      throw new ActionError(`unknown decision: ${decision}`);
    }
    const updated = await decideScenario(ctx.tenantId, {
      scenarioId,
      userId: ctx.userId,
      decision: decision as ScenarioReviewDecision,
      editedText: editedText === '' ? undefined : editedText,
      resolutionNote: resolutionNote === '' ? undefined : resolutionNote,
    });

    if (!isApprovedScenario(updated.status)) return;

    let problem: string | null;
    try {
      problem = await refreshScenarioEmbedding(ctx.tenantId, updated.id);
    } catch (error) {
      console.error('[specs] embedding refresh failed', error);
      problem = 'its embedding was not updated. The next embedding backfill will pick it up.';
    }
    if (problem) {
      throw new ActionError(`Your decision was saved (scenario ${updated.status}), but ${problem}`);
    }
  });
}

/**
 * Emit a deterministic Playwright scaffold from an accepted scenario.
 *
 * Codegen, not an LLM call — the emitter is a pure function of the scenario's steps, so
 * the output is stable and reviewable. The gate is in code: only an approved or edited
 * scenario can have a scaffold emitted, which is the "nothing proceeds to scaffolds
 * without the human gate" rule. The scenario's rendered Gherkin is parsed back into
 * steps so the emitter runs on exactly the reviewed text, hand-edits included.
 */
export async function emitScaffoldAction(formData: FormData): Promise<void> {
  const ctx = await context(formData);
  const scenarioId = String(formData.get('scenarioId') ?? '');

  await settle(ctx.ticketId, async () => {
    const scenario = await getScenario(ctx.tenantId, scenarioId);
    if (!scenario) throw new ActionError('Scenario not found.');
    if (scenario.status !== 'approved' && scenario.status !== 'edited') {
      throw new ActionError('Accept the scenario before emitting a scaffold from it.');
    }

    const ticket = await getTicket(ctx.tenantId, ctx.ticketId);
    if (!ticket) throw new ActionError('Ticket not found.');

    const parsed = parseGherkin(scenario.gherkin_raw);
    const emitted = emitPlaywrightScaffold({
      scenario: { title: parsed.title || scenario.title, steps: parsed.steps },
      externalKey: ticket.external_key,
      scenarioId: scenario.id,
    });

    await saveScaffold(ctx.tenantId, {
      scenarioId: scenario.id,
      ticketId: scenario.ticket_id,
      ticketVersionId: scenario.ticket_version_id,
      framework: emitted.framework,
      code: emitted.code,
      selectorPlaceholders: emitted.selectorPlaceholders,
    });
  });
}

/**
 * Accept / edit / dismiss a scaffold. An edit is where the human replaces the
 * placeholder selectors with real ones, so `edited` requires the filled-in code.
 */
export async function decideScaffoldAction(formData: FormData): Promise<void> {
  const ctx = await context(formData);
  const scaffoldId = String(formData.get('scaffoldId') ?? '');
  const status = String(formData.get('status') ?? '');
  const code = String(formData.get('code') ?? '');

  await settle(ctx.ticketId, async () => {
    if (status !== 'approved' && status !== 'edited' && status !== 'dismissed') {
      throw new ActionError(`unknown scaffold status: ${status}`);
    }
    if (status === 'edited' && !code.trim()) {
      throw new ActionError('An edited scaffold needs the filled-in code.');
    }
    await decideScaffold(ctx.tenantId, {
      scaffoldId,
      status: status as 'approved' | 'edited' | 'dismissed',
      code: status === 'edited' ? code : undefined,
    });
  });
}

/**
 * "Open PR with scaffolds": commits the ticket's approved scaffolds to `specfix/<KEY>` in
 * the mapped repository and opens a PR, or finds the one already open. Owner/admin only;
 * the repository layer re-checks the role and serializes concurrent clicks, so the result
 * is one branch and one PR however often this runs.
 */
export async function openScaffoldPrAction(formData: FormData): Promise<void> {
  const ctx = await context(formData);
  const repositoryId = String(formData.get('repositoryId') ?? '') || null;

  await settle(ctx.ticketId, async () => {
    try {
      await openScaffoldPr(ctx.tenantId, ctx.userId, { ticketId: ctx.ticketId, repositoryId });
    } catch (error) {
      if (error instanceof GithubConnectionError || error instanceof PermanentJobError) {
        throw new ActionError(error.message);
      }
      if (error instanceof GithubAuthError || error instanceof GithubHttpError) {
        console.error('[specs] opening scaffold PR failed', error.message);
        throw new ActionError(
          'GitHub refused the change. Check the app’s repository access and try again.'
        );
      }
      throw error;
    }
  });
}
