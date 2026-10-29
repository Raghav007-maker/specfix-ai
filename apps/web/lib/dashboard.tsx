import 'server-only';
import type { ReactNode } from 'react';
import type { User } from '@supabase/supabase-js';
import { openingQuestion } from '@specfix/agent';
import { FLAG_CATEGORY_LABELS } from '@specfix/shared';
import { agentAccess } from '@/lib/plan';
import {
  agentTablesAvailable,
  findAgentConversation,
  findSession,
  flagBreakdown,
  latestVersion,
  listAgentMessages,
  listDecisionsForTicket,
  readinessTimeline,
  revealedFlags,
  ticketQueue,
  timeToReady,
  weeklyActivity,
  type MembershipRow,
  type ProjectRow,
} from '@/lib/repos';
import { Transcript } from '@/app/tickets/[ticketId]/conversation/conversation';
import type {
  DashboardData,
  HistoryEvent,
  QueueItem,
} from '@/components/playground/dashboard-data';

/** The signed-in user as the dashboard shows them: photo, name and workspace designation. */
export function profileOf(user: User, tenant: MembershipRow | null): DashboardData['user'] {
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return {
    name: text(meta.full_name) ?? text(meta.name),
    email: user.email ?? null,
    avatarUrl: text(meta.avatar_url) ?? text(meta.picture),
    role: tenant?.role ?? null,
    workspace: tenant?.tenant_name ?? null,
  };
}

/**
 * Everything the workspace dashboard shows, read through the same tenant-scoped repositories the
 * app's other pages use. Nothing here writes. `projectId` narrows the queue to one project; the
 * workspace-wide figures (activity, breakdown, time to ready) stay workspace-wide.
 * Throws when a read fails; callers decide what to show instead.
 */
export async function loadWorkspaceDashboard(
  user: User,
  tenant: MembershipRow,
  projects: ProjectRow[],
  projectId?: string
): Promise<{ data: DashboardData; agent: ReactNode }> {
  const t = tenant.tenant_id;
  const scoped = projects.filter((p) => !projectId || p.id === projectId);
  const [queues, weeks, breakdown, ttr] = await Promise.all([
    Promise.all(scoped.map((p) => ticketQueue(t, p.id))),
    weeklyActivity(t, 12),
    flagBreakdown(t),
    timeToReady(t),
  ]);
  const queue: QueueItem[] = scoped.flatMap((p, i) =>
    (queues[i] ?? []).map((r) => ({
      id: r.ticket_id,
      key: r.external_key,
      title: r.title,
      project: p.name,
      totalFlags: r.total_flags,
      openFlags: r.open_flags,
      analyzed: r.analyzed,
      ready: r.ready,
    }))
  );

  const [found, history] = await Promise.all([loadAgent(user, t, queue), loadHistory(t, queue)]);
  return {
    data: {
      source: 'live',
      user: profileOf(user, tenant),
      queue,
      weeks: weeks.map((w) => ({
        week: w.week,
        decisions: w.decisions,
        markedReady: w.markedReady + w.markedReadyBackfilled,
      })),
      breakdown: {
        openBySeverity: breakdown.openBySeverity,
        openByCategory: breakdown.openByCategory.map((c) => ({
          label: (FLAG_CATEGORY_LABELS as Record<string, string>)[c.category] ?? c.category,
          count: c.count,
        })),
        decided: breakdown.decided,
      },
      readyHours: ttr.filter((r) => !r.backfilled).map((r) => r.hours),
      history,
      agent: found.state,
    },
    agent: found.node,
  };
}

const READINESS_KIND: Record<string, HistoryEvent['kind']> = {
  ticket_ingested: 'ingested',
  analysis_complete: 'analysed',
  all_flags_resolved: 'resolved',
  marked_ready: 'ready',
};

/**
 * Every recorded change to the listed tickets, for the calendar: each ticket's readiness timeline
 * and its flag-decision trail, read for all listed tickets in one query each. Decisions keep
 * only their action and author, never the flag's category or question.
 */
async function loadHistory(tenantId: string, queue: QueueItem[]): Promise<HistoryEvent[]> {
  const tickets = new Map(queue.slice(0, 60).map((r) => [r.id, r]));
  if (tickets.size === 0) return [];
  const ids = [...tickets.keys()];
  const [timeline, decisions] = await Promise.all([
    readinessTimeline(tenantId, ids),
    listDecisionsForTicket(tenantId, ids),
  ]);
  const base = (ticketId: string) => {
    const row = tickets.get(ticketId)!;
    return { ticketId, key: row.key, title: row.title };
  };
  return [
    ...timeline
      .filter((e) => !e.backfilled && READINESS_KIND[e.event])
      .map((e) => ({
        ...base(e.ticket_id),
        at: new Date(e.occurred_at).toISOString(),
        kind: READINESS_KIND[e.event]!,
        by: e.user_email,
      })),
    ...decisions.map((d) => ({
      ...base(d.ticket_id),
      at: new Date(d.created_at).toISOString(),
      kind: d.decision as HistoryEvent['kind'],
      by: d.user_email,
    })),
  ].sort((a, b) => b.at.localeCompare(a.at));
}

/**
 * The real Conversation-tab transcript for the first ticket this reviewer can discuss: one that
 * needs a decision and on which they have locked their own gap list. The blind-first rule is
 * the Conversation page's, unchanged: no flag is read for a ticket whose list is not locked.
 */
async function loadAgent(
  user: User,
  tenantId: string,
  queue: QueueItem[]
): Promise<{ state: DashboardData['agent']; node: ReactNode }> {
  const access = await agentAccess(user, tenantId);
  if (access !== 'on') return { state: { state: access }, node: null };
  if (!(await agentTablesAvailable())) return { state: { state: 'not-migrated' }, node: null };

  const candidates = queue
    .filter((r) => r.analyzed && !r.ready && r.openFlags > 0)
    .sort((a, b) => b.openFlags - a.openFlags);
  for (const row of candidates.slice(0, 6)) {
    const version = await latestVersion(tenantId, row.id);
    if (!version) continue;
    const session = await findSession(tenantId, version.id, user.id);
    if (!session || session.gaps_locked_at === null) continue;

    const revealed = await revealedFlags(tenantId, session.id);
    const flags = revealed.flags.filter((f) => f.status !== 'pruned');
    const focus = flags.find((f) => f.status === 'open');
    if (!focus) continue;

    const conversation = await findAgentConversation(tenantId, version.id, user.id);
    const messages = conversation ? await listAgentMessages(tenantId, conversation.id) : [];
    const focusMessages = messages.filter((m) => m.flag_id === focus.id);
    const opener = !focusMessages.some((m) => m.kind === 'question')
      ? openingQuestion({
          category: focus.category,
          severity: focus.severity,
          quotedSpan: focus.quoted_span,
          whatUnclear: focus.what_unclear,
          whyItMatters: focus.why_it_matters,
          questionForPm: focus.edited_question ?? focus.question_for_pm,
        })
      : null;
    const position = flags.findIndex((f) => f.id === focus.id) + 1;

    return {
      state: {
        state: 'ready',
        ticket: { id: row.id, key: row.key, title: row.title, position, total: flags.length },
      },
      node: (
        <Transcript
          ticketId={row.id}
          conversationId={conversation?.id ?? null}
          flag={focus}
          position={position}
          total={flags.length}
          opener={opener}
          messages={focusMessages}
          decided={false}
        />
      ),
    };
  }
  return { state: { state: 'no-ticket' }, node: null };
}
