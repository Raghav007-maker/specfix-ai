import { notFound } from 'next/navigation';
import { requireUser } from '@/lib/session';
import { requireTenant } from '@/lib/tenant';
import { agentAccess } from '@/lib/plan';
import {
  findSession,
  getTicket,
  latestVersion,
  listDecisionsForTicket,
  listGaps,
  listProjects,
  listRunsForTicket,
  readinessTimeline,
  revealedFlags,
  type FlagRow,
  type ReadinessTimelineRow,
  type ReviewerGapRow,
  type TicketDecisionRow,
  currentWritebacks,
  type WritebackRow,
} from '@/lib/repos';
import { AppShell, Breadcrumb } from '@/components/app-shell';
import { TicketTabs } from '@/components/ticket-tabs';
import { EmptyNote, Notice, Pill, SectionHeading } from '@/components/ui';
import { SubmitButton } from '@/components/submit-button';
import { buildManuscript } from '@/lib/manuscript';
import { beginReview, retryWritebackAction } from './actions';
import {
  AuditTrail,
  BlindGapStage,
  LockAction,
  MarkReadyAction,
  ReviewStage,
  TicketText,
} from './stages';

/**
 * One ticket, reviewed under the blind-first protocol.
 *
 * The ordering rule this page exists to honour: until the reviewer's own gap list is
 * locked, this render performs no read against the flags table — not the flags, not
 * their count, not the decision history that quotes them. The repository layer refuses
 * to hand flags over early (revealedFlags throws), but the stronger guarantee is that
 * nothing on the pre-lock path even asks. A reviewer cannot be anchored by output that
 * was never fetched.
 */
export default async function TicketPage({
  params,
  searchParams,
}: {
  params: Promise<{ ticketId: string }>;
  searchParams: Promise<{ error?: string; edit?: string; flag?: string }>;
}) {
  // params, searchParams and the user check are mutually independent, so resolve them
  // together rather than in series.
  const [{ ticketId }, { error, edit, flag: flagParam }, user] = await Promise.all([
    params,
    searchParams,
    requireUser(),
  ]);
  const tenant = await requireTenant(user.id);

  // The project list feeds the sidebar. It reads no ticket or flag data, so it is safe here,
  // ahead of the blind-first branch below.
  const [ticket, projects] = await Promise.all([
    getTicket(tenant.tenant_id, ticketId),
    listProjects(tenant.tenant_id),
  ]);
  if (!ticket) notFound();

  const version = await latestVersion(tenant.tenant_id, ticket.id);

  const session = version ? await findSession(tenant.tenant_id, version.id, user.id) : null;
  const locked = session !== null && session.gaps_locked_at !== null;

  // Everything below is fetched only on the branch that is allowed to see it.
  let gaps: ReviewerGapRow[] = [];
  let flags: FlagRow[] = [];
  let decisions: TicketDecisionRow[] = [];
  let timeline: ReadinessTimelineRow[] = [];
  let analyzed = false;

  if (session && locked) {
    // All five reads depend only on ids already in hand (tenant, session, ticket), so
    // they are independent of one another and run together. They stay inside the
    // `locked` branch: the blind-first rule is that nothing on the pre-lock path even
    // asks for a flag, and parallelising must not move a flag read earlier.
    const [gapsResult, revealed, decisionsResult, timelineResult, runs] = await Promise.all([
      listGaps(tenant.tenant_id, session.id),
      revealedFlags(tenant.tenant_id, session.id),
      listDecisionsForTicket(tenant.tenant_id, ticket.id),
      readinessTimeline(tenant.tenant_id, ticket.id),
      listRunsForTicket(tenant.tenant_id, ticket.id),
    ]);
    gaps = gapsResult;
    flags = revealed.flags;
    decisions = decisionsResult;
    timeline = timelineResult;
    analyzed = runs.some((r) => r.ticket_version_id === version?.id && r.status === 'succeeded');
  } else if (session) {
    gaps = await listGaps(tenant.tenant_id, session.id);
  }

  const writebacks = locked ? await currentWritebacks(tenant.tenant_id, ticket.id) : [];
  const openFlags = flags.filter((f) => f.status === 'open').length;
  const decided = flags.length - openFlags;
  const matched = gaps.filter((g) => g.matched_flag_id !== null).length;
  const sessionDone = session?.stage === 'done';
  const ready = timeline.some(
    (e) => e.event === 'marked_ready' && e.ticket_version_id === version?.id
  );
  // Which flags' quoted spans can be found in the ticket text — empty before lock, because
  // `flags` is never fetched on that path.
  const located = version
    ? buildManuscript(
        version.description_text,
        version.acceptance_criteria_text,
        flags.map((f) => ({ flagId: f.id, quotedSpan: f.quoted_span }))
      ).located
    : new Set<string>();
  // The expanded flag: the one being edited, else the one in the URL, else the first still
  // open, so a decision (which redirects without ?flag) moves the reviewer to the next one.
  const selectedFlagId =
    flags.find((f) => f.id === (edit ?? flagParam))?.id ??
    flags.find((f) => f.status === 'open')?.id ??
    flags[0]?.id;

  // Where the review stands, in one sentence (DESIGN.md §1 "finding line").
  const finding = !version
    ? 'No captured version yet'
    : !session
      ? 'Not started · you write your own gaps before the model’s flags are shown'
      : !locked
        ? `Writing gaps blind · ${plural(gaps.length, 'gap')} so far · the model’s flags stay hidden until you lock`
        : [
            ready ? 'Ready for development' : 'Blind list locked',
            analyzed || flags.length > 0
              ? `${decided} of ${plural(flags.length, 'flag')} decided`
              : 'not analyzed yet',
            gaps.length > 0
              ? `${matched} of ${plural(gaps.length, 'gap')} linked`
              : 'no gaps written',
            sessionDone ? 'session complete' : null,
          ]
            .filter(Boolean)
            .join(' · ');

  return (
    <AppShell
      user={user}
      tenant={tenant}
      projects={projects}
      activeProjectId={ticket.project_id}
      breadcrumb={
        <Breadcrumb
          parent={{ href: `/?project=${ticket.project_id}`, label: ticket.project_name }}
          current={ticket.external_key}
        />
      }
    >
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0 flex-1 basis-80">
          <h1 className="text-balance break-words text-xl font-semibold leading-7 sm:text-[22px]">
            {version?.title ?? ticket.title}
          </h1>
          <p id="finding" className="mt-1 text-sm leading-5 text-muted-foreground">
            {finding}
          </p>
        </div>
        {version ? (
          <div className="flex-none max-sm:w-full">
            {!session ? (
              <form action={beginReview}>
                <input type="hidden" name="ticketId" value={ticket.id} />
                <SubmitButton pendingLabel="Starting…" className="max-sm:w-full">
                  Start blind review
                </SubmitButton>
              </form>
            ) : !locked ? (
              <LockAction ticketId={ticket.id} sessionId={session.id} gapCount={gaps.length} />
            ) : ready ? (
              <Pill tone="positive" className="h-7 px-2 text-sm">
                Ready for development
              </Pill>
            ) : (
              <MarkReadyAction ticketId={ticket.id} openFlags={openFlags} describedBy="finding" />
            )}
          </div>
        ) : null}
      </div>

      <div className="mt-5">
        <TicketTabs
          ticketId={ticket.id}
          active="review"
          agent={await agentAccess(user, tenant.tenant_id)}
        />
      </div>

      {error ? (
        <Notice tone="error" className="mb-6">
          {error}
        </Notice>
      ) : null}

      {ready ? <JiraWritebackStatus ticketId={ticket.id} rows={writebacks} /> : null}

      {!version ? (
        <EmptyNote>
          This ticket has no captured version yet, so there is nothing to review. Versions are
          created on ingest.
        </EmptyNote>
      ) : (
        <div className="grid gap-x-6 gap-y-8 xl:grid-cols-[minmax(0,1fr)_440px]">
          <TicketText version={version} flags={flags} selectedFlagId={selectedFlagId} />

          <div className="min-w-0">
            {!session ? (
              <StartReview />
            ) : !locked ? (
              <BlindGapStage ticketId={ticket.id} session={session} gaps={gaps} />
            ) : (
              <ReviewStage
                ticketId={ticket.id}
                session={session}
                gaps={gaps}
                flags={flags}
                analyzed={analyzed}
                editingFlagId={edit}
                selectedFlagId={selectedFlagId}
                located={located}
              />
            )}
          </div>
        </div>
      )}

      {locked ? (
        <div className="mt-12 border-t border-border pt-8">
          <AuditTrail decisions={decisions} timeline={timeline} />
        </div>
      ) : null}
    </AppShell>
  );
}

function StartReview() {
  return (
    <section aria-labelledby="start-heading" className="space-y-3">
      <SectionHeading id="start-heading">Blind-first review</SectionHeading>
      <p className="text-sm leading-5">
        You review this ticket before you see what the model found. First you write your own list of
        the places a developer would have to guess; then you lock it; only then are the
        model&rsquo;s flags revealed.
      </p>
      <p className="text-sm leading-5 text-muted-foreground">
        The order matters. If you read the model&rsquo;s flags first, your list is anchored to them
        and the recall number would measure agreement, not coverage.
      </p>
    </section>
  );
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** Whether the sign-off reached Jira, with a retry when it did not. */
function JiraWritebackStatus({ ticketId, rows }: { ticketId: string; rows: WritebackRow[] }) {
  if (rows.length === 0) return null;
  const failed = rows.filter((r) => r.status === 'failed');
  if (failed.length > 0) {
    return (
      <Notice tone="warning" className="mb-6" title="Jira was not updated">
        <p>{failed[0]!.error}</p>
        <form action={retryWritebackAction} className="mt-2">
          <input type="hidden" name="ticketId" value={ticketId} />
          <SubmitButton size="sm" variant="outline" pendingLabel="Retrying…">
            Retry Jira update
          </SubmitButton>
        </form>
      </Notice>
    );
  }
  const done = rows.filter((r) => r.status === 'done').map((r) => r.kind);
  if (done.length === 0) return null;
  return (
    <p className="mb-6 text-sm text-muted-foreground">
      Written to Jira:{' '}
      {done
        .map((k) =>
          k === 'comment' ? 'clarified acceptance criteria comment' : 'specfix-ready label'
        )
        .join(' and ')}
      .
    </p>
  );
}
