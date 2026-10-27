import Link from 'next/link';
import { AGENT_MESSAGE_MAX_CHARS, FLAG_CATEGORY_LABELS, type AgentProposal } from '@specfix/shared';
import type { AgentMessageRow, FlagRow } from '@/lib/repos';
import { cn } from '@/lib/cn';
import { Label, Pill, SectionHeading, Textarea, type PillTone } from '@/components/ui';
import { SubmitButton } from '@/components/submit-button';
import { applyProposalAction, declineProposalAction } from './actions';
import { Composer } from './composer';

/**
 * One flag's conversation: the flag, the transcript so far, the agent's latest draft if
 * there is one, and the message box. Server-rendered; the box is the only client island.
 */
export function Transcript({
  ticketId,
  conversationId,
  flag,
  position,
  total,
  opener,
  messages,
  decided,
}: {
  ticketId: string;
  conversationId: string | null;
  flag: FlagRow;
  position: number;
  total: number;
  /** The flag's opening question when it has not been stored yet. */
  opener: string | null;
  messages: AgentMessageRow[];
  /** A decided flag is shown read-only: its transcript and decision, no message box. */
  decided: boolean;
}) {
  return (
    <section aria-labelledby="conversation-heading" className="space-y-4">
      <SectionHeading
        id="conversation-heading"
        aside={
          <span className="text-sm tabular-nums text-muted-foreground">
            Flag {position} of {total}
          </span>
        }
      >
        Conversation
      </SectionHeading>

      <div className="border-l-2 border-teal bg-raised px-3 py-3">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Pill tone={severityTone(flag.severity)}>{capitalize(flag.severity)}</Pill>
          <span className="text-xs text-muted-foreground">{categoryLabel(flag.category)}</span>
        </div>
        <h3 className="mt-2 break-words text-sm font-semibold leading-5">{flag.what_unclear}</h3>
        <p className="mt-1 break-words text-sm leading-5 text-muted-foreground">
          {flag.why_it_matters}
        </p>
      </div>

      <ol aria-label="Messages" className="space-y-4">
        {opener ? (
          <MessageItem role="agent">
            <p className="whitespace-pre-wrap break-words">{opener}</p>
          </MessageItem>
        ) : null}
        {messages.map((message) => (
          <MessageItem key={message.id} role={message.role} decision={message.kind === 'decision'}>
            {message.kind === 'decision' ? (
              <DecisionRecord message={message} />
            ) : (
              <p className="whitespace-pre-wrap break-words">{message.content}</p>
            )}
            {message.proposal && conversationId ? (
              <Draft
                ticketId={ticketId}
                conversationId={conversationId}
                message={message}
                proposal={message.proposal}
                decided={decided}
              />
            ) : null}
          </MessageItem>
        ))}
      </ol>

      {decided ? (
        <p className="text-sm leading-5 text-muted-foreground">
          This flag is {flag.status}
          {messages.length === 0 ? ', and it was decided without a conversation' : ''}. To discuss
          it again, reopen it on the{' '}
          <Link href={`/tickets/${ticketId}?flag=${flag.id}`} className="underline">
            Review tab
          </Link>
          .
        </p>
      ) : (
        <Composer
          key={flag.id}
          ticketId={ticketId}
          flagId={flag.id}
          maxChars={AGENT_MESSAGE_MAX_CHARS}
        />
      )}
    </section>
  );
}

function MessageItem({
  role,
  decision = false,
  children,
}: {
  role: 'agent' | 'pm';
  decision?: boolean;
  children: React.ReactNode;
}) {
  return (
    <li className={cn('text-sm leading-5', role === 'pm' && 'pl-6 sm:pl-10')}>
      <p className="text-xs text-muted-foreground">
        {decision ? 'Decision' : role === 'agent' ? 'Agent' : 'You'}
      </p>
      <div
        className={cn('mt-1', role === 'pm' && !decision ? 'rounded-lg bg-raised px-3 py-2' : null)}
      >
        {children}
      </div>
    </li>
  );
}

function DecisionRecord({ message }: { message: AgentMessageRow }) {
  const label =
    message.decision === 'accepted'
      ? 'Accepted'
      : message.decision === 'edited'
        ? 'Edited'
        : 'Dismissed';
  return (
    <div className="space-y-1">
      <Pill tone={decisionTone(message.decision)}>{label}</Pill>
      {message.content ? (
        <p className="whitespace-pre-wrap break-words text-muted-foreground">
          {message.decision === 'edited' ? 'Question reworded to: ' : ''}
          {message.content}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The agent's drafted decision. Only the latest undecided draft can be applied; earlier
 * ones say what became of them. Applying is the human gate: the reviewer may reword it
 * first, and the decision is recorded through the same path as the Review tab's form.
 */
function Draft({
  ticketId,
  conversationId,
  message,
  proposal,
  decided,
}: {
  ticketId: string;
  conversationId: string;
  message: AgentMessageRow;
  proposal: AgentProposal;
  /** The flag was decided another way; an undecided draft can no longer be applied. */
  decided: boolean;
}) {
  const verb =
    proposal.decision === 'accepted'
      ? 'Accept'
      : proposal.decision === 'edited'
        ? 'Edit the question'
        : 'Dismiss';

  if (message.proposal_status !== 'pending' || decided) {
    const fate =
      message.proposal_status === 'pending'
        ? 'Draft not applied · the flag was decided another way'
        : message.proposal_status === 'applied'
          ? 'Draft applied'
          : message.proposal_status === 'declined'
            ? 'Draft set aside'
            : 'Draft replaced by a later message';
    return (
      <p className="mt-2 text-xs text-muted-foreground">
        {fate} · {verb.toLowerCase()}
      </p>
    );
  }

  const noteId = `note-${message.id}`;
  const questionId = `question-${message.id}`;

  return (
    <div className="mt-3 rounded-lg border border-border bg-sheet px-3 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs text-muted-foreground">Drafted decision</p>
        <Pill tone={decisionTone(proposal.decision)}>{verb}</Pill>
      </div>

      <form action={applyProposalAction} className="mt-3 space-y-3">
        <input type="hidden" name="ticketId" value={ticketId} />
        <input type="hidden" name="conversationId" value={conversationId} />
        <input type="hidden" name="messageId" value={message.id} />
        <input type="hidden" name="flagId" value={message.flag_id} />

        {proposal.decision === 'edited' ? (
          <div className="space-y-2">
            <Label htmlFor={questionId} className="block">
              Reworded question
            </Label>
            <Textarea
              id={questionId}
              name="editedQuestion"
              required
              rows={2}
              defaultValue={proposal.edited_question}
            />
          </div>
        ) : null}

        <div className="space-y-2">
          <Label htmlFor={noteId} className="block">
            {proposal.decision === 'dismissed'
              ? 'Why this isn’t a gap'
              : 'Resolution: what the requirement now says'}
          </Label>
          <Textarea
            id={noteId}
            name="resolutionNote"
            required={proposal.decision === 'accepted'}
            rows={3}
            defaultValue={proposal.resolution_note}
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <SubmitButton variant="secondary" size="sm" pendingLabel="Applying…">
            Apply decision
          </SubmitButton>
        </div>
      </form>

      <form action={declineProposalAction} className="mt-2">
        <input type="hidden" name="ticketId" value={ticketId} />
        <input type="hidden" name="conversationId" value={conversationId} />
        <input type="hidden" name="messageId" value={message.id} />
        <input type="hidden" name="flagId" value={message.flag_id} />
        <SubmitButton variant="ghost" size="sm" pendingLabel="Setting aside…" className="-ml-3">
          Not yet, keep talking
        </SubmitButton>
      </form>
    </div>
  );
}

/** Every flag on the version, so the reviewer can take them in any order. */
export function FlagSwitcher({
  ticketId,
  flags,
  focusId,
}: {
  ticketId: string;
  flags: FlagRow[];
  focusId: string | null;
}) {
  if (flags.length === 0) return null;
  return (
    <section aria-labelledby="switcher-heading" className="space-y-3">
      <SectionHeading id="switcher-heading" count={flags.length} as="h2">
        All flags
      </SectionHeading>
      <ul className="divide-y divide-rule border-y border-rule">
        {flags.map((flag) => {
          const current = flag.id === focusId;
          const body = (
            <>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <Pill tone={severityTone(flag.severity)}>{capitalize(flag.severity)}</Pill>
                <span className="text-xs text-muted-foreground">
                  {categoryLabel(flag.category)}
                </span>
                <span className="flex-1" />
                <Pill tone={statusTone(flag.status)}>{capitalize(flag.status)}</Pill>
              </div>
              <p className="mt-1.5 truncate text-sm">{flag.what_unclear}</p>
            </>
          );
          return (
            <li key={flag.id}>
              {!current ? (
                <Link
                  href={`/tickets/${ticketId}/conversation?flag=${flag.id}`}
                  className="block px-3 py-3 transition-colors hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal"
                >
                  {body}
                </Link>
              ) : (
                <div
                  aria-current={current ? 'true' : undefined}
                  className={cn('px-3 py-3', current && 'border-l-2 border-teal bg-raised')}
                >
                  {body}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
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

function statusTone(status: string): PillTone {
  if (status === 'open') return 'warning';
  if (status === 'accepted') return 'positive';
  if (status === 'edited') return 'accent';
  return 'neutral';
}

function decisionTone(decision: string | null): PillTone {
  if (decision === 'accepted') return 'positive';
  if (decision === 'edited') return 'accent';
  return 'neutral';
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
