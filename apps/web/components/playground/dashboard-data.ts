/**
 * What the dashboard preview renders. The playground page fills it from the signed-in user's
 * workspace through the existing read-only repositories ("live"), or from the labelled sample
 * below when nobody is signed in or the data cannot be read ("sample").
 */
export interface QueueItem {
  id: string;
  key: string;
  title: string;
  project: string;
  totalFlags: number;
  openFlags: number;
  analyzed: boolean;
  ready: boolean;
}

export interface WeekPoint {
  /** Monday of the week, ISO date. */
  week: string;
  decisions: number;
  markedReady: number;
}

/**
 * One change to a ticket, for the dashboard calendar. Flag decisions carry only the action, never
 * the flag's category or question, so the calendar reveals nothing about model flags.
 */
export interface HistoryEvent {
  /** ISO timestamp. */
  at: string;
  ticketId: string;
  key: string;
  title: string;
  kind:
    | 'ingested'
    | 'analysed'
    | 'resolved'
    | 'ready'
    | 'accepted'
    | 'edited'
    | 'dismissed'
    | 'reopened';
  by: string | null;
}

export type AgentState =
  /** The real transcript is in the agent slot. */
  | 'ready'
  | 'signed-out'
  /** SPECFIX_RESOLUTION_AGENT is not "on" in this environment. */
  | 'off'
  /** The workspace is on Free; the agent is a Pro feature. */
  | 'locked'
  | 'not-migrated'
  /** No ticket with a locked gap list and an open flag for this reviewer. */
  | 'no-ticket'
  | 'error';

export interface DashboardData {
  source: 'live' | 'sample';
  /** Why the sample is shown, when it is. */
  sampleReason?: 'signed-out' | 'no-workspace' | 'error';
  user: {
    name: string | null;
    email: string | null;
    avatarUrl: string | null;
    role: 'owner' | 'admin' | 'reviewer' | null;
    workspace: string | null;
  };
  queue: QueueItem[];
  weeks: WeekPoint[];
  /** Flags on each ticket's latest version: open by severity and category, decided by outcome. */
  breakdown: {
    openBySeverity: { high: number; medium: number; low: number };
    /** Category labels are resolved on the server; most open first. */
    openByCategory: { label: string; count: number }[];
    decided: { accepted: number; edited: number; dismissed: number };
  };
  /** Hours from ingest to marked ready, for tickets marked ready live (backfills excluded). */
  readyHours: number[];
  /** Every recorded change to the listed tickets, newest first. */
  history: HistoryEvent[];
  agent: {
    state: AgentState;
    ticket?: { id: string; key: string; title: string; position: number; total: number };
  };
}

/** A few days of illustrative changes ending today, so the sample calendar has something to show. */
function sampleHistory(): HistoryEvent[] {
  const day = (back: number, h: number, m: number) => {
    const d = new Date();
    d.setDate(d.getDate() - back);
    d.setHours(h, m, 0, 0);
    return d.toISOString();
  };
  const t = {
    rate: { ticketId: 's1', key: 'RATE-142', title: 'Rate-limit the partner API' },
    auth: { ticketId: 's2', key: 'AUTH-87', title: 'Lock accounts after repeated failed sign-ins' },
    srch: { ticketId: 's5', key: 'SRCH-9', title: 'Search tickets by external key' },
  };
  return [
    { at: day(0, 14, 19), ...t.rate, kind: 'edited', by: 'reviewer@example.com' },
    { at: day(0, 14, 11), ...t.rate, kind: 'accepted', by: 'reviewer@example.com' },
    { at: day(0, 9, 30), ...t.auth, kind: 'analysed', by: null },
    { at: day(1, 16, 5), ...t.srch, kind: 'ready', by: 'pm@example.com' },
    { at: day(1, 15, 40), ...t.srch, kind: 'resolved', by: null },
    { at: day(1, 11, 2), ...t.srch, kind: 'dismissed', by: 'pm@example.com' },
    { at: day(3, 10, 15), ...t.auth, kind: 'ingested', by: null },
    { at: day(6, 13, 0), ...t.rate, kind: 'ingested', by: null },
  ] as HistoryEvent[];
}

function mondays(n: number): string[] {
  const d = new Date(Date.UTC(2026, 9, 26));
  return Array.from({ length: n }, (_, i) => {
    const x = new Date(d);
    x.setUTCDate(d.getUTCDate() - 7 * (n - 1 - i));
    return x.toISOString().slice(0, 10);
  });
}

const DECISIONS = [6, 9, 4, 12, 8, 14, 11, 7, 15, 10, 13, 9];
const READY = [1, 2, 1, 3, 2, 3, 4, 2, 4, 3, 5, 3];

/** Illustrative only: tickets from the repo's own fixtures style, no real customer data. */
export const SAMPLE: Omit<DashboardData, 'sampleReason'> = {
  source: 'sample',
  user: { name: null, email: null, avatarUrl: null, role: null, workspace: null },
  queue: [
    {
      id: 's1',
      key: 'RATE-142',
      title: 'Rate-limit the partner API',
      project: 'Partner API',
      totalFlags: 6,
      openFlags: 4,
      analyzed: true,
      ready: false,
    },
    {
      id: 's2',
      key: 'AUTH-87',
      title: 'Lock accounts after repeated failed sign-ins',
      project: 'Accounts',
      totalFlags: 5,
      openFlags: 2,
      analyzed: true,
      ready: false,
    },
    {
      id: 's3',
      key: 'EXP-12',
      title: 'Export invoices as CSV for finance',
      project: 'Billing',
      totalFlags: 3,
      openFlags: 0,
      analyzed: true,
      ready: false,
    },
    {
      id: 's4',
      key: 'NOTIF-33',
      title: 'Notify owners when a project is archived',
      project: 'Accounts',
      totalFlags: 0,
      openFlags: 0,
      analyzed: false,
      ready: false,
    },
    {
      id: 's5',
      key: 'SRCH-9',
      title: 'Search tickets by external key',
      project: 'Partner API',
      totalFlags: 4,
      openFlags: 0,
      analyzed: true,
      ready: true,
    },
  ],
  weeks: mondays(12).map((week, i) => ({ week, decisions: DECISIONS[i]!, markedReady: READY[i]! })),
  breakdown: {
    openBySeverity: { high: 3, medium: 2, low: 1 },
    openByCategory: [
      { label: 'Missing info', count: 2 },
      { label: 'Vague language', count: 1 },
      { label: 'Edge case', count: 1 },
      { label: 'Untestable', count: 1 },
      { label: 'Security / compliance', count: 1 },
    ],
    decided: { accepted: 7, edited: 3, dismissed: 2 },
  },
  readyHours: [6.5, 18, 26, 9.5],
  history: sampleHistory(),
  agent: { state: 'signed-out' },
};
