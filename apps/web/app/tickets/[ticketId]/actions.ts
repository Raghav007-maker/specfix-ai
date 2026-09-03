'use server';

/**
 * Every write a reviewer can make against a ticket.
 *
 * Two rules hold across all of them. First, the tenant is resolved from the signed-in
 * user's membership and never from the form — a posted ticketId that belongs to
 * another tenant resolves to nothing and the request is bounced. Second, the
 * repository layer owns the business rules (blind-first ordering, "no ready with open
 * flags", "an edit needs replacement text"); these actions do not restate them, they
 * surface the resulting message to the reviewer.
 */
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { REVIEW_DECISIONS, type ReviewDecision } from '@specfix/shared';
import { requireUser } from '@/lib/session';
import { requireTenant } from '@/lib/tenant';
import {
  addGap,
  completeSession,
  decideFlag,
  flagsForReveal,
  getTicket,
  latestVersion,
  linkGap,
  lockGaps,
  markReady,
  removeGap,
  startSession,
} from '@/lib/repos';

interface Context {
  userId: string;
  tenantId: string;
  ticketId: string;
}

/**
 * Authorize the request. `getTicket` is tenant-scoped, so a ticket id from another
 * tenant comes back null and is indistinguishable from one that does not exist.
 */
async function context(formData: FormData): Promise<Context> {
  const posted = String(formData.get('ticketId') ?? '');
  const user = await requireUser();
  const tenant = await requireTenant(user.id);

  const ticket = await getTicket(tenant.tenant_id, posted);
  if (!ticket) redirect('/');

  return { userId: user.id, tenantId: tenant.tenant_id, ticketId: ticket.id };
}

/**
 * Run a mutation and return to the ticket, carrying any failure as a message rather
 * than an error page. The repositories throw typed errors for the rules that matter
 * (LabelingOrderError, FlagDecisionError, ReadinessError) and their messages are
 * written to be read by a reviewer, so they are shown as-is.
 */
async function settle(ticketId: string, work: () => Promise<void>): Promise<never> {
  let message: string | null = null;
  try {
    await work();
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  revalidatePath(`/tickets/${ticketId}`);
  redirect(
    message ? `/tickets/${ticketId}?error=${encodeURIComponent(message)}` : `/tickets/${ticketId}`
  );
}

/** Opens a labeling session on the current version. Idempotent: resuming is safe. */
export async function beginReview(formData: FormData): Promise<void> {
  const ctx = await context(formData);
  await settle(ctx.ticketId, async () => {
    const version = await latestVersion(ctx.tenantId, ctx.ticketId);
    if (!version) throw new Error('This ticket has no analyzable version yet.');
    await startSession(ctx.tenantId, version.id, ctx.userId);
  });
}

export async function addGapAction(formData: FormData): Promise<void> {
  const ctx = await context(formData);
  const sessionId = String(formData.get('sessionId') ?? '');
  const description = String(formData.get('description') ?? '');

  await settle(ctx.ticketId, async () => {
    await addGap(ctx.tenantId, sessionId, description);
  });
}

export async function removeGapAction(formData: FormData): Promise<void> {
  const ctx = await context(formData);
  const sessionId = String(formData.get('sessionId') ?? '');
  const gapId = String(formData.get('gapId') ?? '');

  await settle(ctx.ticketId, async () => {
    await removeGap(ctx.tenantId, sessionId, gapId);
  });
}

/**
 * The one-way door. Locking freezes the recall denominator and only then are the
 * model's flags fetched — both in a single action, so there is no window in which a
 * reviewer has locked but the reveal has not been recorded.
 */
export async function lockAndReveal(formData: FormData): Promise<void> {
  const ctx = await context(formData);
  const sessionId = String(formData.get('sessionId') ?? '');

  await settle(ctx.ticketId, async () => {
    await lockGaps(ctx.tenantId, sessionId);
    await flagsForReveal(ctx.tenantId, sessionId);
  });
}

/** Links a reviewer gap to the model flag that covers it, or clears the link. */
export async function linkGapAction(formData: FormData): Promise<void> {
  const ctx = await context(formData);
  const sessionId = String(formData.get('sessionId') ?? '');
  const gapId = String(formData.get('gapId') ?? '');
  const raw = String(formData.get('flagId') ?? '');

  await settle(ctx.ticketId, async () => {
    await linkGap(ctx.tenantId, sessionId, gapId, raw === '' ? null : raw);
  });
}

export async function completeSessionAction(formData: FormData): Promise<void> {
  const ctx = await context(formData);
  const sessionId = String(formData.get('sessionId') ?? '');

  await settle(ctx.ticketId, async () => {
    await completeSession(ctx.tenantId, sessionId);
  });
}

/** Accept / edit / dismiss / reopen. Writes the status and its audit row together. */
export async function decideFlagAction(formData: FormData): Promise<void> {
  const ctx = await context(formData);
  const flagId = String(formData.get('flagId') ?? '');
  const decision = String(formData.get('decision') ?? '');
  const editedText = String(formData.get('editedText') ?? '').trim();
  const resolutionNote = String(formData.get('resolutionNote') ?? '').trim();

  await settle(ctx.ticketId, async () => {
    if (!REVIEW_DECISIONS.includes(decision as ReviewDecision)) {
      throw new Error(`unknown decision: ${decision}`);
    }
    await decideFlag(ctx.tenantId, {
      flagId,
      userId: ctx.userId,
      decision: decision as ReviewDecision,
      editedText: editedText === '' ? undefined : editedText,
      resolutionNote: resolutionNote === '' ? undefined : resolutionNote,
    });
  });
}

/** Marks the ticket ready for development. Refused while any flag is still open. */
export async function markReadyAction(formData: FormData): Promise<void> {
  const ctx = await context(formData);
  await settle(ctx.ticketId, async () => {
    await markReady(ctx.tenantId, ctx.ticketId, ctx.userId);
  });
}
