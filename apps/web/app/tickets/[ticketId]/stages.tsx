import type { ReactNode } from 'react';
import Link from 'next/link';
import { ArrowUpRight, Pencil } from 'lucide-react';
import { FLAG_CATEGORY_LABELS } from '@specfix/shared';
import type {
  FlagRow,
  LabelingSessionRow,
  ReadinessTimelineRow,
  ReviewerGapRow,
  TicketDecisionRow,
  TicketVersionDetail,
} from '@/lib/repos';
import { buildManuscript, type Segment } from '@/lib/manuscript';
import { cn } from '@/lib/cn';
import {
  EmptyNote,
  Label,
  Notice,
  Pill,
  SectionHeading,
  Select,
  Textarea,
  buttonClasses,
  linkClasses,
  type PillTone,
} from '@/components/ui';
import { SubmitButton } from '@/components/submit-button';
import { ConfirmSubmit } from '@/components/confirm-dialog';
import {
  addGapAction,
  completeSessionAction,
  decideFlagAction,
  linkGapAction,
  lockAndReveal,
  markReadyAction,
  removeGapAction,
} from './actions';

/**
 * The ticket exactly as the model saw it — the same version every flag is keyed to. When flags
 * are passed (only after the gap list is locked; the page never fetches them before), each
 * flag's quoted words are tinted where they appear verbatim, the selected flag's darker.
 */
export function TicketText({
  version,
  flags = [],
  selectedFlagId,
}: {
  version: TicketVersionDetail;
  flags?: FlagRow[];
  selectedFlagId?: string;
}) {
  const manuscript = buildManuscript(
    version.description_text,
    version.acceptance_criteria_text,
    flags.map((f) => ({ flagId: f.id, quotedSpan: f.quoted_span }))
  );

  return (
    <section
      aria-labelledby="ticket-heading"
      className="xl:sticky xl:top-4 xl:max-h-[calc(100vh-2rem)] xl:overflow-y-auto xl:pr-2"
    >
      <details open className="group">
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal xl:pointer-events-none xl:min-h-8">
          <h2 id="ticket-heading" className="text-base font-semibold">
            Ticket
          </h2>
          <span className="text-sm text-muted-foreground xl:hidden">
            <span className="group-open:hidden">Show</span>
            <span className="hidden group-open:inline">Hide</span>
          </span>
        </summary>

        <div className="mt-3 max-w-reading text-[15px] leading-6">
          <h3 className="text-sm font-medium text-muted-foreground">Description</h3>
          {version.description_text ? (
            <p className="mt-1 whitespace-pre-wrap break-words">
              <Segments segments={manuscript.description} selectedFlagId={selectedFlagId} />
            </p>
          ) : (
            <p className="mt-1 text-muted-foreground">None provided.</p>
          )}

          <h3 className="mt-6 text-sm font-medium text-muted-foreground">Acceptance criteria</h3>
          {manuscript.clauses.length > 0 ? (
            <ol className="mt-1 list-decimal space-y-2 pl-6 marker:text-sm marker:text-muted-foreground">
              {manuscript.clauses.map((clause, index) => (
                <li key={index} className="whitespace-pre-wrap break-words pl-1">
                  <Segments segments={clause} selectedFlagId={selectedFlagId} />
                </li>
              ))}
            </ol>
          ) : (
            <p className="mt-1 text-muted-foreground">None provided.</p>
          )}
        </div>
      </details>
    </section>
  );
}

function Segments({ segments, selectedFlagId }: { segments: Segment[]; selectedFlagId?: string }) {
  return (
    <>
      {segments.map((seg, i) =>
        seg.flagId ? (
          <mark
            key={i}
            id={`span-${seg.flagId}`}
            className={cn(
              'scroll-mt-24 rounded-sm border-b-2 border-teal px-0.5 text-text [box-decoration-break:clone]',
              seg.flagId === selectedFlagId ? 'bg-mark-selected' : 'bg-mark'
            )}
          >
            {reflow(seg.text)}
          </mark>
        ) : (
          <span key={i}>{reflow(seg.text)}</span>
        )
      )}
    </>
  );
}

/**
 * Join hard-wrapped lines inside a paragraph so the text reflows to the column; blank lines
 * (paragraph breaks) stay. Display only — span matching ran on the original text.
 */
function reflow(text: string): string {
  return text.replace(/(?<!\n)\r?\n(?!\r?\n)/g, ' ');
}

/**
 * Stage one: the reviewer writes their own gap list with the model's output nowhere
 * on the page. Nothing in this component — or in the server render that produced it —
 * has read the flags table, which is the point: recall is only meaningful if the
 * denominator was written blind. The lock itself is the title row's primary action.
 */
export function BlindGapStage({
  ticketId,
  session,
  gaps,
}: {
  ticketId: string;
  session: LabelingSessionRow;
  gaps: ReviewerGapRow[];
}) {
  return (
    <section aria-labelledby="gaps-heading" className="space-y-4">
      <SectionHeading id="gaps-heading" count={gaps.length}>
        Your gaps
      </SectionHeading>
      <p className="text-sm leading-5 text-muted-foreground">
        Write down every place a developer would have to guess. The model&rsquo;s flags stay hidden
        until you lock this list, so your list measures what it misses.
      </p>

      {gaps.length === 0 ? (
        <EmptyNote>No gaps written yet.</EmptyNote>
      ) : (
        <ol className="divide-y divide-rule border-y border-rule">
          {gaps.map((gap, index) => (
            <li
              key={gap.id}
              className="grid grid-cols-[1.5rem_minmax(0,1fr)_auto] items-start gap-2 py-3"
            >
              <span className="pt-px text-sm tabular-nums text-muted-foreground">{index + 1}.</span>
              <p className="break-words text-sm leading-5">{gap.description}</p>
              <form action={removeGapAction}>
                <input type="hidden" name="ticketId" value={ticketId} />
                <input type="hidden" name="sessionId" value={session.id} />
                <input type="hidden" name="gapId" value={gap.id} />
                <SubmitButton
                  variant="ghost"
                  size="sm"
                  pendingLabel="Removing…"
                  aria-label={`Remove gap ${index + 1}`}
                  className="-my-1"
                >
                  Remove
                </SubmitButton>
              </form>
            </li>
          ))}
        </ol>
      )}

      <form action={addGapAction} className="space-y-2">
        <input type="hidden" name="ticketId" value={ticketId} />
        <input type="hidden" name="sessionId" value={session.id} />
        <Label htmlFor="new-gap" className="block">
          Add a gap
        </Label>
        <Textarea
          id="new-gap"
          name="description"
          required
          rows={3}
          autoComplete="off"
          placeholder="e.g. The ticket doesn’t say what happens when the refund exceeds the original charge…"
        />
        <SubmitButton variant="secondary" size="sm" pendingLabel="Adding…">
          Add gap
        </SubmitButton>
      </form>

      <Notice tone="warning">
        Locking is permanent: afterwards you can&rsquo;t add or remove gaps. Locking an empty list
        is a valid answer: it records that you found nothing a developer would have to guess.
      </Notice>
    </section>
  );
}

/** The title row's primary action during the blind stage. */
export function LockAction({
  ticketId,
  sessionId,
  gapCount,
}: {
  ticketId: string;
  sessionId: string;
  gapCount: number;
}) {
  const noun = gapCount === 1 ? 'gap' : 'gaps';
  return (
    <ConfirmSubmit
      action={lockAndReveal}
      fields={{ ticketId, sessionId }}
      label={`Lock ${gapCount} ${noun} and reveal flags`}
      pendingLabel="Locking…"
      title="Lock your gap list?"
      body={
        <p>
          You are locking {gapCount} {noun}. You won&rsquo;t be able to add or remove gaps
          afterwards, and the model&rsquo;s flags are revealed straight away.
        </p>
      }
      confirmLabel="Lock and reveal"
    />
  );
}

/** "Mark ready for development" — refused by the repository while a flag is open. */
export function MarkReadyAction({
  ticketId,
  openFlags,
  describedBy,
}: {
  ticketId: string;
  openFlags: number;
  describedBy: string;
}) {
  return (
    <form action={markReadyAction} className="max-sm:w-full">
      <input type="hidden" name="ticketId" value={ticketId} />
      <SubmitButton
        disabled={openFlags > 0}
        aria-describedby={describedBy}
        pendingLabel="Marking ready…"
        className="max-sm:w-full"
      >
        Mark ready for development
      </SubmitButton>
    </form>
  );
}

/**
 * Stage two: the model's flags beside the ticket, the reviewer's locked list, and the two ways
 * they produce numbers — a verdict on each flag (precision) and a link from each gap to the flag
 * that covers it, or to nothing (recall).
 */
export function ReviewStage({
  ticketId,
  session,
  gaps,
  flags,
  analyzed,
  editingFlagId,
  selectedFlagId,
  located,
}: {
  ticketId: string;
  session: LabelingSessionRow;
  gaps: ReviewerGapRow[];
  flags: FlagRow[];
  analyzed: boolean;
  editingFlagId: string | undefined;
  selectedFlagId: string | undefined;
  located: Set<string>;
}) {
  const matched = gaps.filter((g) => g.matched_flag_id !== null).length;
  const undecided = flags.filter((f) => f.status === 'open').length;
  const done = session.stage === 'done';

  return (
    <div className="space-y-10">
      <section aria-labelledby="flags-heading" className="space-y-3">
        <SectionHeading
          id="flags-heading"
          count={flags.length}
          aside={
            flags.length === 0 ? null : undecided > 0 ? (
              <Pill tone="warning">{undecided} open</Pill>
            ) : (
              <Pill tone="positive">All decided</Pill>
            )
          }
        >
          Flags
        </SectionHeading>
        {flags.length === 0 ? (
          <EmptyFlags analyzed={analyzed} />
        ) : (
          <ul className="divide-y divide-rule border-y border-rule">
            {flags.map((flag) => (
              <FlagRowItem
                key={flag.id}
                ticketId={ticketId}
                flag={flag}
                selected={flag.id === selectedFlagId}
                editing={editingFlagId === flag.id}
                located={located.has(flag.id)}
              />
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="links-heading" className="space-y-3">
        <SectionHeading
          id="links-heading"
          count={gaps.length}
          aside={
            gaps.length > 0 ? (
              <span className="text-sm tabular-nums text-muted-foreground">
                {matched} of {gaps.length} linked
              </span>
            ) : null
          }
        >
          Your gaps
        </SectionHeading>
        <p className="text-sm leading-5 text-muted-foreground">
          Point each gap at the flag that covers it. Leave a gap unlinked when the model
          didn&rsquo;t raise it. That miss is what recall counts.
        </p>
        {gaps.length === 0 ? (
          <EmptyNote>You locked an empty list, so there is nothing to link.</EmptyNote>
        ) : (
          <ol className="divide-y divide-rule border-y border-rule">
            {gaps.map((gap, index) => (
              <GapLinkRow
                key={gap.id}
                ticketId={ticketId}
                sessionId={session.id}
                gap={gap}
                flags={flags}
                index={index}
                disabled={done}
              />
            ))}
          </ol>
        )}
      </section>

      <section
        aria-labelledby="session-heading"
        className="flex flex-wrap items-center justify-between gap-4"
      >
        <div className="min-w-0 flex-1 text-sm leading-5">
          <h2 id="session-heading" className="font-medium">
            {done ? 'Labeling session complete' : 'Labeling session'}
          </h2>
          <p className="text-muted-foreground">
            {done
              ? 'This session counts toward the recall measurement.'
              : 'Completing it locks in your links and adds this ticket to the recall measurement.'}
          </p>
        </div>
        {done ? (
          <Pill tone="positive">Complete</Pill>
        ) : (
          <ConfirmSubmit
            action={completeSessionAction}
            fields={{ ticketId, sessionId: session.id }}
            variant="secondary"
            label="Complete session"
            pendingLabel="Completing…"
            title="Complete this labeling session?"
            body={
              <p>
                Your gap links are locked in and this ticket is counted in the recall measurement.
                {matched < gaps.length
                  ? ` ${gaps.length - matched} unlinked ${gaps.length - matched === 1 ? 'gap is' : 'gaps are'} recorded as misses.`
                  : ''}
              </p>
            }
            confirmLabel="Complete session"
          />
        )}
      </section>
    </div>
  );
}

function EmptyFlags({ analyzed }: { analyzed: boolean }) {
  // These two states look identical in the flags table and mean opposite things. A
  // reviewer linking gaps against "the model never ran" would record fake misses.
  return analyzed ? (
    <EmptyNote>
      The model analyzed this version and raised no flags. Any gaps you found are misses.
    </EmptyNote>
  ) : (
    <Notice tone="warning" title="This version hasn’t been analyzed yet">
      There are no flags to compare against. Don&rsquo;t complete this session: it would record your
      gaps as misses against a model that never ran.
    </Notice>
  );
}

function FlagRowItem({
  ticketId,
  flag,
  selected,
  editing,
  located,
}: {
  ticketId: string;
  flag: FlagRow;
  selected: boolean;
  editing: boolean;
  located: boolean;
}) {
  const question = flag.edited_question ?? flag.question_for_pm;
  const status = flagStatus(flag.status);
  const anchor = `flag-${flag.id}`;
  const self = `/tickets/${ticketId}?flag=${flag.id}`;

  const meta = (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <Pill tone={severityTone(flag.severity)}>{capitalize(flag.severity)}</Pill>
      <span className="text-xs text-muted-foreground">{categoryLabel(flag.category)}</span>
      <span className="flex-1" />
      <Pill tone={status.tone}>{status.label}</Pill>
    </div>
  );

  if (!selected) {
    return (
      <li id={anchor} className="scroll-mt-6">
        <Link
          href={`${self}#${anchor}`}
          scroll={false}
          className="block space-y-1.5 px-3 py-3 transition-colors hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal"
        >
          {meta}
          <p className="truncate text-sm">{flag.what_unclear}</p>
        </Link>
      </li>
    );
  }

  return (
    <li
      id={anchor}
      aria-current="true"
      className="scroll-mt-6 border-l-2 border-teal bg-raised px-3 py-4"
    >
      {meta}
      <h3 className="mt-2 break-words text-sm font-semibold leading-5">{flag.what_unclear}</h3>
      <p className="mt-1 break-words text-sm leading-5 text-muted-foreground">
        {flag.why_it_matters}
      </p>

      {flag.quoted_span ? (
        <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <q className="break-words rounded-sm border-b-2 border-teal bg-mark-selected px-1 text-sm">
            {flag.quoted_span}
          </q>
          {located ? (
            <a
              href={`#span-${flag.id}`}
              className={cn(linkClasses, 'inline-flex items-center gap-1 text-sm text-teal-ink')}
            >
              Show in ticket
              <ArrowUpRight aria-hidden size={14} strokeWidth={1.5} />
            </a>
          ) : null}
        </div>
      ) : null}

      <div className="mt-3 rounded-lg border border-border bg-sheet px-3 py-2">
        <p className="text-xs text-muted-foreground">
          Question for the PM{flag.edited_question ? ' · edited by reviewer' : ''}
        </p>
        <p className="mt-1 break-words text-sm leading-5">{question}</p>
      </div>

      {editing ? (
        <form action={decideFlagAction} className="mt-3 space-y-2">
          <input type="hidden" name="ticketId" value={ticketId} />
          <input type="hidden" name="flagId" value={flag.id} />
          <input type="hidden" name="decision" value="edited" />
          <Label htmlFor={`edit-${flag.id}`} className="block">
            Rewrite the question for the PM
          </Label>
          <Textarea
            id={`edit-${flag.id}`}
            name="editedText"
            required
            rows={3}
            autoComplete="off"
            defaultValue={question}
          />
          <div className="flex flex-wrap items-center gap-2">
            <SubmitButton variant="secondary" size="sm" pendingLabel="Saving…">
              Save and accept
            </SubmitButton>
            <Link
              href={`${self}#${anchor}`}
              scroll={false}
              className={buttonClasses('ghost', 'sm')}
            >
              Cancel
            </Link>
          </div>
        </form>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {flag.status === 'open' ? (
            <>
              <DecisionButton
                ticketId={ticketId}
                flagId={flag.id}
                decision="accepted"
                label="Accept"
                pendingLabel="Accepting…"
                variant="secondary"
              />
              <Link
                href={`${self}&edit=${flag.id}#${anchor}`}
                scroll={false}
                className={buttonClasses('outline', 'sm')}
              >
                <Pencil aria-hidden size={14} strokeWidth={1.5} />
                Edit wording
              </Link>
              <DecisionButton
                ticketId={ticketId}
                flagId={flag.id}
                decision="dismissed"
                label="Dismiss"
                pendingLabel="Dismissing…"
                variant="ghost"
              />
            </>
          ) : flag.status === 'stale' ? (
            <p className="text-sm text-muted-foreground">
              Raised against an older version of this ticket.
            </p>
          ) : (
            <DecisionButton
              ticketId={ticketId}
              flagId={flag.id}
              decision="reopened"
              label="Reopen"
              pendingLabel="Reopening…"
              variant="outline"
            />
          )}
        </div>
      )}
    </li>
  );
}

function DecisionButton({
  ticketId,
  flagId,
  decision,
  label,
  pendingLabel,
  variant,
}: {
  ticketId: string;
  flagId: string;
  decision: string;
  label: string;
  pendingLabel: string;
  variant: 'secondary' | 'outline' | 'ghost';
}) {
  return (
    <form action={decideFlagAction}>
      <input type="hidden" name="ticketId" value={ticketId} />
      <input type="hidden" name="flagId" value={flagId} />
      <input type="hidden" name="decision" value={decision} />
      <SubmitButton size="sm" variant={variant} pendingLabel={pendingLabel}>
        {label}
      </SubmitButton>
    </form>
  );
}

function GapLinkRow({
  ticketId,
  sessionId,
  gap,
  flags,
  index,
  disabled,
}: {
  ticketId: string;
  sessionId: string;
  gap: ReviewerGapRow;
  flags: FlagRow[];
  index: number;
  disabled: boolean;
}) {
  const selectId = `link-${gap.id}`;
  return (
    <li className="py-3">
      <div className="grid grid-cols-[1.5rem_minmax(0,1fr)_auto] items-start gap-2">
        <span className="pt-px text-sm tabular-nums text-muted-foreground">{index + 1}.</span>
        <p className="break-words text-sm leading-5">{gap.description}</p>
        <Pill tone={gap.matched_flag_id ? 'positive' : 'neutral'}>
          {gap.matched_flag_id ? 'Matched' : 'Missed'}
        </Pill>
      </div>

      <form action={linkGapAction} className="mt-2 flex flex-wrap items-end gap-2 pl-8">
        <input type="hidden" name="ticketId" value={ticketId} />
        <input type="hidden" name="sessionId" value={sessionId} />
        <input type="hidden" name="gapId" value={gap.id} />
        <div className="min-w-0 flex-1 basis-48 space-y-1">
          <Label htmlFor={selectId} className="block text-xs font-normal text-muted-foreground">
            Covered by
          </Label>
          <Select
            id={selectId}
            name="flagId"
            defaultValue={gap.matched_flag_id ?? ''}
            disabled={disabled}
            className="h-8 max-sm:h-11"
          >
            <option value="">Not raised by the model (a miss)</option>
            {flags.map((flag) => (
              <option key={flag.id} value={flag.id}>
                {categoryLabel(flag.category)} — {truncate(flag.question_for_pm, 80)}
              </option>
            ))}
          </Select>
        </div>
        <SubmitButton size="sm" variant="outline" disabled={disabled} pendingLabel="Saving…">
          Save link
        </SubmitButton>
      </form>
    </li>
  );
}

/**
 * The audit trail. Every status a flag has ever held and every readiness event, with
 * the person responsible — this is the evidence behind the precision metric, so it is
 * shown in full rather than summarized.
 */
export function AuditTrail({
  decisions,
  timeline,
}: {
  decisions: TicketDecisionRow[];
  timeline: ReadinessTimelineRow[];
}) {
  return (
    <div className="grid gap-10 xl:grid-cols-2 xl:gap-6">
      <section aria-labelledby="decisions-heading" className="space-y-3">
        <SectionHeading id="decisions-heading" count={decisions.length}>
          Decision history
        </SectionHeading>
        {decisions.length === 0 ? (
          <EmptyNote>No decisions recorded yet.</EmptyNote>
        ) : (
          <ul className="divide-y divide-rule border-y border-rule">
            {decisions.map((d) => (
              <LedgerRow key={d.id} stamp={stamp(d.created_at)}>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <Pill tone={decisionTone(d.decision)}>{capitalize(d.decision)}</Pill>
                  <span className="break-all text-muted-foreground">
                    {d.user_email ?? 'unknown user'}
                  </span>
                </div>
                <p className="mt-1 break-words">
                  {categoryLabel(d.category)} — {truncate(d.question_for_pm, 120)}
                </p>
                {d.edited_text ? (
                  <p className="mt-1 break-words text-muted-foreground">
                    Rewritten to: {d.edited_text}
                  </p>
                ) : null}
              </LedgerRow>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="timeline-heading" className="space-y-3">
        <SectionHeading id="timeline-heading" count={timeline.length}>
          Readiness timeline
        </SectionHeading>
        {timeline.length === 0 ? (
          <EmptyNote>No events recorded yet.</EmptyNote>
        ) : (
          <ul className="divide-y divide-rule border-y border-rule">
            {timeline.map((e) => (
              <LedgerRow key={e.id} stamp={stamp(e.occurred_at)}>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="font-medium">{capitalize(e.event.replace(/_/g, ' '))}</span>
                  {e.backfilled ? <Pill tone="neutral">Backfilled</Pill> : null}
                </div>
                {e.user_email ? (
                  <p className="mt-0.5 break-all text-muted-foreground">{e.user_email}</p>
                ) : null}
              </LedgerRow>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function LedgerRow({ stamp: when, children }: { stamp: string; children: ReactNode }) {
  return (
    <li className="grid gap-x-4 gap-y-1 py-3 text-sm leading-5 sm:grid-cols-[9.5rem_minmax(0,1fr)]">
      <span className="text-xs tabular-nums text-muted-foreground sm:pt-0.5 max-sm:order-last">
        {when}
      </span>
      <div className="min-w-0">{children}</div>
    </li>
  );
}

function categoryLabel(category: string): string {
  return (FLAG_CATEGORY_LABELS as Record<string, string>)[category] ?? category;
}

function severityTone(severity: string): PillTone {
  if (severity === 'high') return 'negative';
  if (severity === 'medium') return 'warning';
  return 'neutral';
}

function flagStatus(status: string): { tone: PillTone; label: string } {
  if (status === 'open') return { tone: 'warning', label: 'Open' };
  if (status === 'accepted') return { tone: 'positive', label: 'Accepted' };
  if (status === 'edited') return { tone: 'accent', label: 'Edited' };
  return { tone: 'neutral', label: capitalize(status) };
}

function decisionTone(decision: string): PillTone {
  if (decision === 'accepted') return 'positive';
  if (decision === 'edited') return 'accent';
  if (decision === 'dismissed') return 'neutral';
  return 'warning';
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** UTC, unambiguous. An audit trail read across timezones must not be guessable. */
function stamp(value: Date | string): string {
  return `${new Date(value).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}
