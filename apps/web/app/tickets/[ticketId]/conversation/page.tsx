import Link from 'next/link';
import { notFound } from 'next/navigation';
import { openingQuestion } from '@specfix/agent';
import { requireUser } from '@/lib/session';
import { requireTenant } from '@/lib/tenant';
import { resolutionAgentEnabled } from '@/lib/agent';
import {
  agentTablesAvailable,
  findAgentConversation,
  findSession,
  getTicket,
  latestVersion,
  listAgentMessages,
  listProjects,
  readinessTimeline,
  revealedFlags,
  type AgentConversationRow,
  type AgentMessageRow,
  type FlagRow,
} from '@/lib/repos';
import { AppShell, Breadcrumb } from '@/components/app-shell';
import { TicketTabs } from '@/components/ticket-tabs';
import { EmptyNote, Notice, Pill, linkClasses } from '@/components/ui';
import { MarkReadyAction, TicketText } from '../stages';
import { FlagSwitcher, Transcript } from './conversation';

/**
 * The Conversation tab: the resolution agent, an alternative to the Review tab's form for
 * deciding the same flags (Phase 2, Milestone F). The agent asks about one open flag at a
 * time and may draft a decision; the reviewer applies it or keeps talking.
 *
 * The blind-first rule is the Review page's, unchanged: until this reviewer's gap list is
 * locked, this render reads nothing from the flags table — and so the agent, which only
 * ever talks about flags, has nothing to say yet.
 */
export default async function ConversationPage({
  params,
  searchParams,
}: {
  params: Promise<{ ticketId: string }>;
  searchParams: Promise<{ error?: string; flag?: string }>;
}) {
  if (!resolutionAgentEnabled()) notFound();

  const [{ ticketId }, { error, flag: flagParam }, user] = await Promise.all([
    params,
    searchParams,
    requireUser(),
  ]);
  const tenant = await requireTenant(user.id);

  const [ticket, projects] = await Promise.all([
    getTicket(tenant.tenant_id, ticketId),
    listProjects(tenant.tenant_id),
  ]);
  if (!ticket) notFound();

  const version = await latestVersion(tenant.tenant_id, ticket.id);
  const session = version ? await findSession(tenant.tenant_id, version.id, user.id) : null;
  const locked = session !== null && session.gaps_locked_at !== null;
  const migrated = await agentTablesAvailable();

  let flags: FlagRow[] = [];
  let conversation: AgentConversationRow | null = null;
  let messages: AgentMessageRow[] = [];
  let ready = false;

  if (version && session && locked && migrated) {
    const [revealed, found, timeline] = await Promise.all([
      revealedFlags(tenant.tenant_id, session.id),
      findAgentConversation(tenant.tenant_id, version.id, user.id),
      readinessTimeline(tenant.tenant_id, ticket.id),
    ]);
    // The Critic's pruned flags were never meant for review (the form excludes them too).
    flags = revealed.flags.filter((f) => f.status !== 'pruned');
    conversation = found;
    messages = found ? await listAgentMessages(tenant.tenant_id, found.id) : [];
    ready = timeline.some((e) => e.event === 'marked_ready' && e.ticket_version_id === version.id);
  }

  const open = flags.filter((f) => f.status === 'open');
  const decided = flags.length - open.length;
  // A decided flag can be opened to reread its conversation; by default the first open one.
  const focus = flags.find((f) => f.id === flagParam) ?? open[0] ?? null;
  const focusOpen = focus?.status === 'open';

  const focusMessages = focus ? messages.filter((m) => m.flag_id === focus.id) : [];
  // The opener is shown before it is stored: it is the flag's own question, and it is
  // written with the reviewer's first message so that reading this page writes nothing.
  const opener =
    focus && focusOpen && !focusMessages.some((m) => m.kind === 'question')
      ? openingQuestion({
          category: focus.category,
          severity: focus.severity,
          quotedSpan: focus.quoted_span,
          whatUnclear: focus.what_unclear,
          whyItMatters: focus.why_it_matters,
          questionForPm: focus.edited_question ?? focus.question_for_pm,
        })
      : null;
  const decisionsByAgent = messages.filter((m) => m.kind === 'decision').length;

  const finding = !version
    ? 'No captured version yet'
    : !locked
      ? 'Lock your gap list on the Review tab first · the model’s flags stay hidden until then'
      : !migrated
        ? 'Waiting on database migration 0008'
        : flags.length === 0
          ? 'No flags to discuss'
          : [
              ready ? 'Ready for development' : null,
              `${decided} of ${plural(flags.length, 'flag')} decided`,
              open.length > 0 ? `${open.length} open` : 'nothing left to discuss',
              decisionsByAgent > 0 ? `${decisionsByAgent} decided here` : null,
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
        {version && locked && migrated && flags.length > 0 ? (
          <div className="flex-none max-sm:w-full">
            {ready ? (
              <Pill tone="positive" className="h-7 px-2 text-sm">
                Ready for development
              </Pill>
            ) : (
              <MarkReadyAction ticketId={ticket.id} openFlags={open.length} describedBy="finding" />
            )}
          </div>
        ) : null}
      </div>

      <div className="mt-5">
        <TicketTabs ticketId={ticket.id} active="conversation" />
      </div>

      {error ? (
        <Notice tone="error" className="mb-6">
          {error}
        </Notice>
      ) : null}

      {!version ? (
        <EmptyNote>
          This ticket has no captured version yet, so there is nothing to discuss. Versions are
          created on ingest.
        </EmptyNote>
      ) : !locked ? (
        <section aria-labelledby="locked-heading" className="max-w-reading space-y-3">
          <h2 id="locked-heading" className="text-base font-semibold">
            Your gap list comes first
          </h2>
          <p className="text-sm leading-5">
            The agent talks you through the model&rsquo;s flags, and those stay hidden until you
            have written and locked your own list of gaps. That order is what keeps the recall
            measurement honest.
          </p>
          <Link href={`/tickets/${ticket.id}`} className={`${linkClasses} text-sm underline`}>
            Go to the Review tab
          </Link>
        </section>
      ) : !migrated ? (
        <Notice tone="warning" title="The agent isn’t set up on this database yet">
          Apply migration <code className="font-mono">0008_resolution_agent.sql</code> (
          <code className="font-mono">npm run db:migrate</code>) to store conversations. Until then,
          decide flags on the Review tab.
        </Notice>
      ) : (
        <div className="grid gap-x-6 gap-y-8 xl:grid-cols-[minmax(0,1fr)_440px]">
          <TicketText version={version} flags={flags} selectedFlagId={focus?.id} />

          <div className="min-w-0 space-y-8">
            {flags.length === 0 ? (
              <EmptyNote>
                The model raised no flags on this version, so there is nothing for the agent to ask
                about.
              </EmptyNote>
            ) : focus ? (
              <Transcript
                ticketId={ticket.id}
                conversationId={conversation?.id ?? null}
                flag={focus}
                position={flags.findIndex((f) => f.id === focus.id) + 1}
                total={flags.length}
                opener={opener}
                messages={focusMessages}
                decided={!focusOpen}
              />
            ) : (
              <Notice tone="success" title="Every flag is decided">
                {ready
                  ? 'This ticket is marked ready for development.'
                  : 'Mark the ticket ready for development when you are happy with the decisions.'}{' '}
                The decisions are in the Review tab&rsquo;s decision history.
              </Notice>
            )}

            <FlagSwitcher ticketId={ticket.id} flags={flags} focusId={focus?.id ?? null} />

            <p className="text-sm leading-5 text-muted-foreground">
              The agent only drafts. Nothing is decided until you apply a draft, and every decision
              is recorded in the same history as the Review tab&rsquo;s. You can switch to the{' '}
              <Link href={`/tickets/${ticket.id}`} className={`${linkClasses} underline`}>
                form
              </Link>{' '}
              at any point.
            </p>
          </div>
        </div>
      )}
    </AppShell>
  );
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
