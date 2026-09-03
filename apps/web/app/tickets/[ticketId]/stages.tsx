import type { ReactNode } from 'react';
import { FLAG_CATEGORY_LABELS } from '@specfix/shared';
import type {
  FlagRow,
  LabelingSessionRow,
  ReadinessTimelineRow,
  ReviewerGapRow,
  TicketDecisionRow,
  TicketVersionDetail,
} from '@/lib/repos';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Textarea } from '@/components/ui';
import {
  addGapAction,
  completeSessionAction,
  decideFlagAction,
  linkGapAction,
  lockAndReveal,
  markReadyAction,
  removeGapAction,
} from './actions';

/** The ticket exactly as the model saw it — the same version every flag is keyed to. */
export function TicketText({ version }: { version: TicketVersionDetail }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Ticket</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <Field label="Title">{version.title}</Field>
        <Field label="Description">{version.description_text || '(none provided)'}</Field>
        <Field label="Acceptance criteria">
          {version.acceptance_criteria_text || '(none provided)'}
        </Field>
      </CardContent>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="whitespace-pre-wrap leading-relaxed">{children}</p>
    </div>
  );
}

/**
 * Stage one: the reviewer writes their own gap list with the model's output nowhere
 * on the page. Nothing in this component — or in the server render that produced it —
 * has read the flags table, which is the point: recall is only meaningful if the
 * denominator was written blind.
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
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Your gap list</CardTitle>
        <p className="text-sm text-muted-foreground">
          Read the ticket and write down every place a developer would have to guess. The
          model&rsquo;s flags stay hidden until you lock this list — that is what makes the recall
          number trustworthy.
        </p>
      </CardHeader>

      <CardContent className="space-y-5">
        {gaps.length === 0 ? (
          <p className="rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
            No gaps written yet.
          </p>
        ) : (
          <ol className="space-y-2">
            {gaps.map((gap, index) => (
              <li key={gap.id} className="flex items-start gap-3 rounded-md border px-3 py-2">
                <span className="mt-0.5 text-xs font-medium text-muted-foreground">
                  {index + 1}
                </span>
                <p className="flex-1 text-sm leading-relaxed">{gap.description}</p>
                <form action={removeGapAction}>
                  <input type="hidden" name="ticketId" value={ticketId} />
                  <input type="hidden" name="sessionId" value={session.id} />
                  <input type="hidden" name="gapId" value={gap.id} />
                  <Button type="submit" variant="ghost" size="sm">
                    Remove
                  </Button>
                </form>
              </li>
            ))}
          </ol>
        )}

        <form action={addGapAction} className="space-y-2">
          <input type="hidden" name="ticketId" value={ticketId} />
          <input type="hidden" name="sessionId" value={session.id} />
          <Textarea
            name="description"
            required
            rows={3}
            placeholder="e.g. The ticket doesn't say what happens when the refund amount exceeds the original charge."
          />
          <Button type="submit" variant="secondary" size="sm">
            Add gap
          </Button>
        </form>

        <div className="rounded-md border border-amber-200 bg-amber-50 p-4">
          <p className="text-sm font-medium text-amber-900">Locking is permanent for this ticket</p>
          <p className="mt-1 text-sm text-amber-800">
            After you lock, you cannot add or remove gaps. Locking an empty list is a valid answer —
            it records &ldquo;I found nothing a developer would have to guess&rdquo;.
          </p>
          <form action={lockAndReveal} className="mt-3">
            <input type="hidden" name="ticketId" value={ticketId} />
            <input type="hidden" name="sessionId" value={session.id} />
            <Button type="submit">
              Lock {gaps.length} {gaps.length === 1 ? 'gap' : 'gaps'} and reveal the model&rsquo;s
              flags
            </Button>
          </form>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Stage two: the model's flags, the reviewer's locked list, and the two ways they
 * produce numbers — a verdict on each flag (precision) and a link from each gap to the
 * flag that covers it, or to nothing (recall).
 */
export function ReviewStage({
  ticketId,
  session,
  gaps,
  flags,
  analyzed,
  editingFlagId,
}: {
  ticketId: string;
  session: LabelingSessionRow;
  gaps: ReviewerGapRow[];
  flags: FlagRow[];
  analyzed: boolean;
  editingFlagId: string | undefined;
}) {
  const matched = gaps.filter((g) => g.matched_flag_id !== null).length;
  const undecided = flags.filter((f) => f.status === 'open').length;
  const done = session.stage === 'done';

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="text-base">
              Model flags{' '}
              <span className="font-normal text-muted-foreground">({flags.length})</span>
            </CardTitle>
            {undecided > 0 ? (
              <Badge tone="warning">{undecided} undecided</Badge>
            ) : (
              <Badge tone="success">All decided</Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            Accept the ones that are real issues, edit the wording where the question is right but
            phrased badly, dismiss the noise. Every verdict is recorded.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          {flags.length === 0 ? (
            <EmptyFlags analyzed={analyzed} />
          ) : (
            flags.map((flag) => (
              <FlagCard
                key={flag.id}
                ticketId={ticketId}
                flag={flag}
                editing={editingFlagId === flag.id}
              />
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="text-base">
              Your locked gap list{' '}
              <span className="font-normal text-muted-foreground">({gaps.length})</span>
            </CardTitle>
            <Badge tone={matched === gaps.length ? 'success' : 'neutral'}>
              {matched}/{gaps.length} matched
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            For each gap you found, point at the model flag that covers it. A gap left unlinked is a
            miss — that is exactly what recall is counting, so leave it unlinked rather than forcing
            a match.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          {gaps.length === 0 ? (
            <p className="rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
              You locked an empty list, so there is nothing to link.
            </p>
          ) : (
            gaps.map((gap, index) => (
              <GapLinkRow
                key={gap.id}
                ticketId={ticketId}
                sessionId={session.id}
                gap={gap}
                flags={flags}
                index={index}
                disabled={done}
              />
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-4 py-5">
          <div className="text-sm">
            <p className="font-medium">
              {done ? 'Labeling session complete' : 'Finish this labeling session'}
            </p>
            <p className="text-muted-foreground">
              {done
                ? 'This session now counts toward the recall measurement.'
                : 'Completing it locks in your links and includes this ticket in the recall measurement.'}
            </p>
          </div>
          {done ? (
            <Badge tone="success">Done</Badge>
          ) : (
            <form action={completeSessionAction}>
              <input type="hidden" name="ticketId" value={ticketId} />
              <input type="hidden" name="sessionId" value={session.id} />
              <Button type="submit" variant="secondary">
                Complete labeling session
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function EmptyFlags({ analyzed }: { analyzed: boolean }) {
  // These two states look identical in the flags table and mean opposite things. A
  // reviewer linking gaps against "the model never ran" would record fake misses.
  return analyzed ? (
    <p className="rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
      The model analyzed this version and raised no flags. Any gaps you found are misses.
    </p>
  ) : (
    <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-4 text-sm text-amber-900">
      This version has not been analyzed yet, so there are no flags to compare against. Do not
      complete this session — it would record your gaps as misses against a model that never ran.
    </p>
  );
}

function FlagCard({
  ticketId,
  flag,
  editing,
}: {
  ticketId: string;
  flag: FlagRow;
  editing: boolean;
}) {
  const question = flag.edited_question ?? flag.question_for_pm;

  return (
    <div className="rounded-lg border p-4">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Badge tone={severityTone(flag.severity)}>{flag.severity}</Badge>
        <Badge tone="muted">{categoryLabel(flag.category)}</Badge>
        <span className="flex-1" />
        <Badge tone={statusTone(flag.status)}>{flag.status}</Badge>
      </div>

      <p className="font-medium leading-snug">{flag.what_unclear}</p>
      <p className="mt-1 text-sm text-muted-foreground">{flag.why_it_matters}</p>

      {flag.quoted_span ? (
        <blockquote className="mt-3 border-l-2 border-border pl-3 font-mono text-xs text-muted-foreground">
          {flag.quoted_span}
        </blockquote>
      ) : null}

      <div className="mt-3 rounded-md bg-muted/60 p-3">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Question for the PM
          {flag.edited_question ? ' · edited by reviewer' : ''}
        </p>
        <p className="mt-1 text-sm">{question}</p>
      </div>

      {editing ? (
        <form action={decideFlagAction} className="mt-3 space-y-2">
          <input type="hidden" name="ticketId" value={ticketId} />
          <input type="hidden" name="flagId" value={flag.id} />
          <input type="hidden" name="decision" value="edited" />
          <Textarea
            name="editedText"
            required
            rows={3}
            defaultValue={question}
            aria-label="Rewrite the question for the PM"
          />
          <div className="flex gap-2">
            <Button type="submit" size="sm">
              Save edit and accept
            </Button>
            <a href={`/tickets/${ticketId}`} className="text-sm text-muted-foreground underline">
              Cancel
            </a>
          </div>
        </form>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          {flag.status === 'open' ? (
            <>
              <DecisionButton
                ticketId={ticketId}
                flagId={flag.id}
                decision="accepted"
                label="Accept"
              />
              <a
                href={`/tickets/${ticketId}?edit=${flag.id}`}
                className="inline-flex h-8 items-center rounded-md border border-input px-3 text-xs font-medium hover:bg-accent"
              >
                Edit wording
              </a>
              <DecisionButton
                ticketId={ticketId}
                flagId={flag.id}
                decision="dismissed"
                label="Dismiss"
                variant="ghost"
              />
            </>
          ) : flag.status === 'stale' ? (
            <p className="text-xs text-muted-foreground">
              Raised against an older version of this ticket.
            </p>
          ) : (
            <DecisionButton
              ticketId={ticketId}
              flagId={flag.id}
              decision="reopened"
              label="Reopen"
              variant="outline"
            />
          )}
        </div>
      )}
    </div>
  );
}

function DecisionButton({
  ticketId,
  flagId,
  decision,
  label,
  variant = 'secondary',
}: {
  ticketId: string;
  flagId: string;
  decision: string;
  label: string;
  variant?: 'default' | 'secondary' | 'outline' | 'ghost';
}) {
  return (
    <form action={decideFlagAction}>
      <input type="hidden" name="ticketId" value={ticketId} />
      <input type="hidden" name="flagId" value={flagId} />
      <input type="hidden" name="decision" value={decision} />
      <Button type="submit" size="sm" variant={variant}>
        {label}
      </Button>
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
  return (
    <div className="rounded-md border p-3">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 text-xs font-medium text-muted-foreground">{index + 1}</span>
        <p className="flex-1 text-sm leading-relaxed">{gap.description}</p>
        <Badge tone={gap.matched_flag_id ? 'success' : 'muted'}>
          {gap.matched_flag_id ? 'matched' : 'missed'}
        </Badge>
      </div>

      <form action={linkGapAction} className="mt-2 flex flex-wrap items-center gap-2 pl-6">
        <input type="hidden" name="ticketId" value={ticketId} />
        <input type="hidden" name="sessionId" value={sessionId} />
        <input type="hidden" name="gapId" value={gap.id} />
        <select
          name="flagId"
          defaultValue={gap.matched_flag_id ?? ''}
          disabled={disabled}
          className="h-8 max-w-md flex-1 rounded-md border border-input bg-background px-2 text-xs disabled:opacity-50"
        >
          <option value="">— not raised by the model (a miss) —</option>
          {flags.map((flag) => (
            <option key={flag.id} value={flag.id}>
              {categoryLabel(flag.category)} — {truncate(flag.question_for_pm, 80)}
            </option>
          ))}
        </select>
        <Button type="submit" size="sm" variant="outline" disabled={disabled}>
          Save link
        </Button>
      </form>
    </div>
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
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Decision history</CardTitle>
        </CardHeader>
        <CardContent>
          {decisions.length === 0 ? (
            <p className="text-sm text-muted-foreground">No decisions recorded yet.</p>
          ) : (
            <ul className="space-y-3">
              {decisions.map((d) => (
                <li key={d.id} className="border-l-2 border-border pl-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={decisionTone(d.decision)}>{d.decision}</Badge>
                    <span className="text-muted-foreground">{d.user_email ?? 'unknown user'}</span>
                    <span className="text-xs text-muted-foreground">{stamp(d.created_at)}</span>
                  </div>
                  <p className="mt-1 text-muted-foreground">
                    {categoryLabel(d.category)} — {truncate(d.question_for_pm, 120)}
                  </p>
                  {d.edited_text ? (
                    <p className="mt-1 rounded bg-muted/60 px-2 py-1 text-xs">
                      rewritten to: {d.edited_text}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Readiness timeline</CardTitle>
        </CardHeader>
        <CardContent>
          {timeline.length === 0 ? (
            <p className="text-sm text-muted-foreground">No events recorded yet.</p>
          ) : (
            <ul className="space-y-3">
              {timeline.map((e) => (
                <li key={e.id} className="border-l-2 border-border pl-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{e.event.replace(/_/g, ' ')}</span>
                    {e.backfilled ? <Badge tone="muted">backfilled</Badge> : null}
                    <span className="text-xs text-muted-foreground">{stamp(e.occurred_at)}</span>
                  </div>
                  {e.user_email ? <p className="text-muted-foreground">{e.user_email}</p> : null}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/** "Mark ready for development" — refused by the repository while a flag is open. */
export function MarkReady({
  ticketId,
  openFlags,
  ready,
}: {
  ticketId: string;
  openFlags: number;
  ready: boolean;
}) {
  return (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-4 py-5">
        <div className="text-sm">
          <p className="font-medium">Ready for development</p>
          <p className="text-muted-foreground">
            {ready
              ? 'This version has been marked ready.'
              : openFlags > 0
                ? `${openFlags} flag${openFlags === 1 ? '' : 's'} still open — resolve them first.`
                : 'Every flag on this version has been resolved.'}
          </p>
        </div>
        {ready ? (
          <Badge tone="success">Marked ready</Badge>
        ) : (
          <form action={markReadyAction}>
            <input type="hidden" name="ticketId" value={ticketId} />
            <Button type="submit" disabled={openFlags > 0}>
              Mark ready for development
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

function categoryLabel(category: string): string {
  return (FLAG_CATEGORY_LABELS as Record<string, string>)[category] ?? category;
}

function severityTone(severity: string): 'danger' | 'warning' | 'muted' {
  if (severity === 'high') return 'danger';
  if (severity === 'medium') return 'warning';
  return 'muted';
}

function statusTone(status: string): 'neutral' | 'success' | 'primary' | 'muted' {
  if (status === 'accepted') return 'success';
  if (status === 'edited') return 'primary';
  if (status === 'open') return 'neutral';
  return 'muted';
}

function decisionTone(decision: string): 'success' | 'primary' | 'muted' | 'neutral' {
  if (decision === 'accepted') return 'success';
  if (decision === 'edited') return 'primary';
  if (decision === 'dismissed') return 'muted';
  return 'neutral';
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** UTC, unambiguous. An audit trail read across timezones must not be guessable. */
function stamp(value: Date | string): string {
  return `${new Date(value).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}
