'use client';

import { useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import {
  ArrowUpRight,
  BadgeCheck,
  BarChart3,
  Bell,
  ChevronRight,
  CircleCheck,
  CircleDashed,
  House,
  LogIn,
  LogOut,
  MessagesSquare,
  Plug,
  UserRound,
  Users,
  Flag,
  Folder,
  Gem,
} from 'lucide-react';
import { signOut } from '@/app/(auth)/actions';
import type { Settings } from './settings';
import type { DashboardData, QueueItem, WeekPoint } from './dashboard-data';
import { Logo } from './logo';
import { DateCalendar } from './date-calendar';
import { AvatarEditor } from './avatar-editor';
import { PricingView } from './pricing-view';
import s from './playground.module.css';

type View = 'queue' | 'analytics' | 'pricing';

const VIEW_LABEL: Record<View, string> = {
  queue: 'Home',
  analytics: 'Ticket analytics',
  pricing: 'Pricing',
};
type Filter = 'all' | 'need' | 'waiting' | 'resolved' | 'ready';

function statusOf(r: QueueItem): Exclude<Filter, 'all'> {
  if (!r.analyzed) return 'waiting';
  if (r.ready) return 'ready';
  return r.openFlags > 0 ? 'need' : 'resolved';
}

const STATUS_LABEL: Record<Exclude<Filter, 'all'>, string> = {
  need: 'Needs decision',
  waiting: 'Not analysed',
  resolved: 'Flags resolved',
  ready: 'Ready for dev',
};

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/**
 * The signed-in workspace after the supplied dashboard screenshots: navigation on the left, the
 * review queue in the middle, the reviewer and the resolution agent on the right. It renders the
 * real workspace when the page could read it, and says plainly when it is showing a sample.
 */
export function DashboardPreview({
  settings,
  data,
  agent,
  goLogin,
  projects,
  activeProjectId,
  top,
  pricing = false,
}: {
  settings: Settings;
  data: DashboardData;
  /** The real Conversation-tab transcript, server-rendered, when one is available. */
  agent: ReactNode;
  goLogin: () => void;
  /** The workspace's projects, listed in the sidebar as filters for the queue. */
  projects?: { id: string; name: string }[];
  activeProjectId?: string;
  /** Server-rendered notices and forms shown above the queue (errors, switchers, setup). */
  top?: ReactNode;
  /** Shows the Pricing prototype in the sidebar (design playground only, until plans ship). */
  pricing?: boolean;
}) {
  const [view, setView] = useState<View>('queue');
  const live = data.source === 'live';
  const l = settings.layout;
  // Pricing takes the full width; the reviewer panel has nothing to say about plans.
  const showRight = l.showRight && view !== 'pricing';
  const b = settings.brand;

  const nav = (
    <>
      <NavButton
        icon={<House aria-hidden />}
        active={view === 'queue'}
        onClick={() => setView('queue')}
      >
        Home
      </NavButton>
      <NavButton
        icon={<BarChart3 aria-hidden />}
        active={view === 'analytics'}
        onClick={() => setView('analytics')}
      >
        Ticket analytics
      </NavButton>
      <a className={s.navItem} href="/inbox">
        <Bell aria-hidden />
        <span>Inbox</span>
        <ArrowUpRight aria-hidden className={s.navOut} />
      </a>
      <a className={s.navItem} href="/team">
        <Users aria-hidden />
        <span>Team</span>
        <ArrowUpRight aria-hidden className={s.navOut} />
      </a>
      <a className={s.navItem} href="/settings/integrations">
        <Plug aria-hidden />
        <span>Integrations</span>
        <ArrowUpRight aria-hidden className={s.navOut} />
      </a>
      {/* The playground shows its own Pricing prototype; the workspace links to the real page. */}
      {pricing ? (
        <NavButton
          icon={<Gem aria-hidden />}
          active={view === 'pricing'}
          onClick={() => setView('pricing')}
        >
          Pricing
        </NavButton>
      ) : (
        <a className={s.navItem} href="/pricing">
          <Gem aria-hidden />
          <span>Pricing</span>
          <ArrowUpRight aria-hidden className={s.navOut} />
        </a>
      )}
      {projects && projects.length > 0 ? (
        <>
          <p className={s.navGroup}>Projects</p>
          <a className={s.navItem} href="/" aria-current={!activeProjectId ? 'page' : undefined}>
            <Folder aria-hidden />
            <span>All projects</span>
          </a>
          {projects.map((p) => (
            <a
              key={p.id}
              className={s.navItem}
              href={`/?project=${p.id}`}
              aria-current={p.id === activeProjectId ? 'page' : undefined}
            >
              <Folder aria-hidden />
              <span>{p.name}</span>
            </a>
          ))}
        </>
      ) : null}
    </>
  );

  return (
    <div
      className={s.dash}
      data-sidebar={l.showSidebar ? 'on' : 'off'}
      data-right={showRight ? 'on' : 'off'}
    >
      {l.showSidebar ? (
        <aside className={s.side} aria-label="Workspace">
          <div className={s.sideLogo}>
            <Logo
              variant={b.logoVariant}
              size={b.logoSize * 0.9}
              animation={b.logoAnimation}
              loop={b.logoLoop}
            />
          </div>
          <nav aria-label="Main" className={s.sideNav}>
            {nav}
          </nav>
          <div className={s.sideFoot}>
            {live ? (
              <form action={signOut}>
                <button type="submit" className={s.navItem}>
                  <LogOut aria-hidden />
                  <span>Sign out</span>
                </button>
              </form>
            ) : (
              <button type="button" className={s.navItem} onClick={goLogin}>
                <LogIn aria-hidden />
                <span>Sign in</span>
              </button>
            )}
          </div>
        </aside>
      ) : null}

      <main id="main" className={s.work} aria-label={VIEW_LABEL[view]}>
        {!live && view !== 'pricing' ? (
          <SampleBanner reason={data.sampleReason} goLogin={goLogin} />
        ) : null}
        {top}
        {view === 'queue' ? (
          <QueueView data={data} live={live} />
        ) : view === 'analytics' ? (
          <AnalyticsView data={data} live={live} />
        ) : (
          <PricingView />
        )}
      </main>

      {showRight ? (
        <aside className={s.right} aria-label="Reviewer and agent">
          <Profile
            data={data}
            live={live}
            goLogin={goLogin}
            onAnalytics={() => setView('analytics')}
          />
          <AgentPanel data={data} agent={agent} goLogin={goLogin} />
        </aside>
      ) : null}
    </div>
  );
}

function NavButton({
  icon,
  active,
  onClick,
  children,
}: {
  icon: ReactNode;
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={s.navItem}
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
    >
      {icon}
      <span>{children}</span>
    </button>
  );
}

function SampleBanner({
  reason,
  goLogin,
}: {
  reason?: DashboardData['sampleReason'];
  goLogin: () => void;
}) {
  const why =
    reason === 'error'
      ? 'The workspace could not be read just now, so this is sample data.'
      : reason === 'no-workspace'
        ? 'Your account has no workspace yet, so this is sample data.'
        : 'You are signed out, so this is sample data.';
  return (
    <p className={s.banner} role="note">
      <b>Sample data.</b> {why} Nothing here is a real ticket or a real measurement.
      {reason === 'signed-out' || !reason ? (
        <button type="button" onClick={goLogin}>
          Sign in to see yours
        </button>
      ) : null}
    </p>
  );
}

function greeting(name: string | null, email: string | null): string {
  const first = name?.trim().split(/\s+/)[0] ?? email?.split('@')[0];
  return first ? `Hello, ${first}` : 'Hello';
}

/**
 * Home, laid out like the supplied dashboard screenshot: a greeting with the date and its calendar
 * of ticket changes, three figures with their change, and the review queue as a plain list.
 */
function QueueView({ data, live }: { data: DashboardData; live: boolean }) {
  const [filter, setFilter] = useState<Filter>('all');
  const c = useMemo(() => {
    const out = { need: 0, waiting: 0, resolved: 0, ready: 0, open: 0, total: 0 };
    for (const r of data.queue) {
      out[statusOf(r)]++;
      out.open += r.openFlags;
      out.total += r.totalFlags;
    }
    return out;
  }, [data.queue]);
  const rows = filter === 'all' ? data.queue : data.queue.filter((r) => statusOf(r) === filter);
  const ordered = [...rows].sort((a, b) => b.openFlags - a.openFlags);
  const decided = c.total - c.open;
  const donePct = c.total ? Math.round((decided / c.total) * 100) : 0;
  const readyPct = data.queue.length ? Math.round((c.ready / data.queue.length) * 100) : 0;
  const thisWeek = data.weeks.at(-1)?.decisions ?? 0;

  return (
    <>
      <header className={s.helloHead}>
        <div>
          <h1 className={s.workTitle}>
            {live ? greeting(data.user.name, data.user.email) : 'Hello'}
          </h1>
          <p className={s.muted}>
            {data.queue.length === 0
              ? 'Track review progress here. Ingest tickets into a project to get started.'
              : c.open > 0
                ? `Track review progress here. ${plural(c.open, 'flag')} still need your decision.`
                : 'Track review progress here. Every flag has a decision.'}
          </p>
        </div>
        <DateCalendar history={data.history} linkTickets={live} />
      </header>

      <dl className={s.stats}>
        <Stat
          icon={<CircleCheck aria-hidden />}
          label="Decided"
          value={String(decided)}
          delta={thisWeek > 0 ? `+${thisWeek} this week` : undefined}
          tone="up"
        />
        <Stat
          icon={<Flag aria-hidden />}
          label="Open flags"
          value={String(c.open)}
          delta={c.need > 0 ? `in ${plural(c.need, 'ticket')}` : undefined}
          tone="down"
        />
        <Stat
          icon={<BarChart3 aria-hidden />}
          label="Ready"
          value={`${readyPct}%`}
          delta={`${c.ready} of ${plural(data.queue.length, 'ticket')}`}
          tone="flat"
        />
      </dl>

      <section className={s.flat} aria-labelledby="pg-queue-h">
        <div className={s.flatHead}>
          <h2 id="pg-queue-h" className={s.h2}>
            Review queue
          </h2>
          <span className={s.donePct}>Done {donePct}%</span>
          <label className={s.pillSelect}>
            <span className={s.srOnly}>Show</span>
            <select value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
              <option value="all">All</option>
              <option value="need">{STATUS_LABEL.need}</option>
              <option value="waiting">{STATUS_LABEL.waiting}</option>
              <option value="resolved">{STATUS_LABEL.resolved}</option>
              <option value="ready">{STATUS_LABEL.ready}</option>
            </select>
          </label>
        </div>
        {ordered.length === 0 ? (
          <p className={s.empty}>
            {data.queue.length === 0
              ? 'No tickets in this workspace yet.'
              : 'No tickets in this state right now.'}
          </p>
        ) : (
          <ul className={s.taskList}>
            {ordered.map((r) => {
              const st = statusOf(r);
              return (
                <li key={r.id}>
                  <span className={s.taskIcon} data-status={st} aria-hidden="true">
                    {st === 'ready' ? (
                      <CircleCheck />
                    ) : st === 'waiting' ? (
                      <CircleDashed />
                    ) : (
                      <Flag />
                    )}
                  </span>
                  <span className={s.taskTitle}>
                    <b>{r.title}</b>
                    <code>{r.key}</code>
                  </span>
                  <span className={s.status} data-status={st}>
                    {STATUS_LABEL[st]}
                  </span>
                  <span className={s.taskFlags}>
                    <Flag aria-hidden />
                    {r.analyzed
                      ? r.totalFlags === 0
                        ? 'none'
                        : `${r.openFlags}/${r.totalFlags}`
                      : '—'}
                  </span>
                  {live ? (
                    <a
                      className={s.taskGo}
                      href={`/tickets/${r.id}`}
                      aria-label={`${st === 'need' ? 'Review' : 'Open'} ${r.key}`}
                    >
                      <ChevronRight aria-hidden />
                    </a>
                  ) : (
                    <span
                      className={s.taskGo}
                      data-disabled="true"
                      title="Sample tickets have no page"
                    >
                      <ChevronRight aria-hidden />
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}

function Stat({
  icon,
  label,
  value,
  delta,
  tone,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  delta?: string;
  tone: 'up' | 'down' | 'flat';
}) {
  return (
    <div className={s.stat}>
      <span className={s.statIcon}>{icon}</span>
      <div>
        <dt>{label}</dt>
        <dd>
          <b>{value}</b>{' '}
          {delta ? (
            <span className={s.delta} data-tone={tone}>
              {delta}
            </span>
          ) : null}
        </dd>
      </div>
    </div>
  );
}

/**
 * A smooth path through the points that never overshoots them (monotone cubic, Fritsch–Carlson),
 * so a week of zero is drawn at zero, not below the axis.
 */
function curve(pts: [number, number][]): string {
  const n = pts.length;
  if (n === 0) return '';
  if (n < 3) return pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x} ${y}`).join(' ');
  const dx: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(pts[i + 1]![0] - pts[i]![0]);
    slope.push((pts[i + 1]![1] - pts[i]![1]) / (dx[i] || 1));
  }
  const t: number[] = [slope[0]!];
  for (let i = 1; i < n - 1; i++) {
    const a = slope[i - 1]!;
    const b = slope[i]!;
    t.push(
      a * b <= 0
        ? 0
        : (3 * (dx[i - 1]! + dx[i]!)) /
            ((2 * dx[i]! + dx[i - 1]!) / a + (dx[i]! + 2 * dx[i - 1]!) / b)
    );
  }
  t.push(slope[n - 2]!);
  let d = `M${pts[0]![0]} ${pts[0]![1]}`;
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = pts[i]!;
    const [x1, y1] = pts[i + 1]!;
    const h = dx[i]! / 3;
    d += ` C${x0 + h} ${y0 + t[i]! * h} ${x1 - h} ${y1 - t[i + 1]! * h} ${x1} ${y1}`;
  }
  return d;
}

function ActivityChart({ weeks, live }: { weeks: WeekPoint[]; live: boolean }) {
  const [range, setRange] = useState<6 | 12>(12);
  const [focus, setFocus] = useState<number | null>(null);
  const data = weeks.slice(-range);
  const W = 640;
  const H = 200;
  const pad = { l: 34, r: 12, t: 12, b: 26 };
  const max = Math.max(4, ...data.map((w) => Math.max(w.decisions, w.markedReady)));
  const top = Math.ceil(max / 4) * 4;
  const x = (i: number) =>
    pad.l + (data.length <= 1 ? 0 : (i * (W - pad.l - pad.r)) / (data.length - 1));
  const y = (v: number) => pad.t + (1 - v / top) * (H - pad.t - pad.b);
  const fmt = (iso: string) =>
    new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(
      new Date(iso)
    );
  const total = data.reduce((a, w) => a + w.decisions, 0);
  const f = focus !== null ? data[focus] : null;

  return (
    <section className={s.flat} aria-labelledby="pg-chart-h">
      <div className={s.flatHead}>
        <div>
          <h2 id="pg-chart-h" className={s.h2}>
            Review activity
          </h2>
          <p className={s.muted}>
            Flag decisions and tickets marked ready, per week{live ? '' : ' · sample'}.
          </p>
        </div>
        <label className={s.pillSelect}>
          <span className={s.srOnly}>Range</span>
          <select value={range} onChange={(e) => setRange(Number(e.target.value) as 6 | 12)}>
            <option value={6}>Last 6 weeks</option>
            <option value={12}>Last 12 weeks</option>
          </select>
        </label>
      </div>
      {total === 0 && data.every((w) => w.markedReady === 0) ? (
        <p className={s.empty}>No decisions recorded in the last {range} weeks.</p>
      ) : (
        <div className={s.chart}>
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
            <defs>
              <linearGradient id="pg-area" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0" stopColor="currentColor" stopOpacity="0.12" />
                <stop offset="1" stopColor="currentColor" stopOpacity="0" />
              </linearGradient>
            </defs>
            {[0, 0.25, 0.5, 0.75, 1].map((t) => (
              <g key={t}>
                <line
                  x1={pad.l}
                  x2={W - pad.r}
                  y1={y(top * t)}
                  y2={y(top * t)}
                  className={s.gridLine}
                />
                <text x={pad.l - 8} y={y(top * t) + 4} textAnchor="end" className={s.axis}>
                  {Math.round(top * t)}
                </text>
              </g>
            ))}
            <path
              d={`${curve(data.map((w, i) => [x(i), y(w.decisions)]))} L${x(data.length - 1)} ${y(0)} L${x(0)} ${y(0)} Z`}
              fill="url(#pg-area)"
              className={s.seriesA}
            />
            <path
              d={curve(data.map((w, i) => [x(i), y(w.decisions)]))}
              className={`${s.line} ${s.seriesA}`}
            />
            <path
              d={curve(data.map((w, i) => [x(i), y(w.markedReady)]))}
              className={`${s.line} ${s.seriesB}`}
            />
            {f ? (
              <>
                <line x1={x(focus!)} x2={x(focus!)} y1={pad.t} y2={y(0)} className={s.focusLine} />
                <circle
                  cx={x(focus!)}
                  cy={y(f.decisions)}
                  r={4}
                  className={s.seriesA}
                  fill="currentColor"
                />
                <circle
                  cx={x(focus!)}
                  cy={y(f.markedReady)}
                  r={4}
                  className={s.seriesB}
                  fill="currentColor"
                />
              </>
            ) : null}
            {data.map((w, i) =>
              i % (range === 12 ? 2 : 1) === 0 ? (
                <text key={w.week} x={x(i)} y={H - 6} textAnchor="middle" className={s.axis}>
                  {fmt(w.week)}
                </text>
              ) : null
            )}
          </svg>
          <div className={s.hits} onMouseLeave={() => setFocus(null)}>
            {data.map((w, i) => (
              <button
                key={w.week}
                type="button"
                aria-label={`Week of ${fmt(w.week)}: ${plural(w.decisions, 'decision')}, ${w.markedReady} marked ready`}
                onMouseEnter={() => setFocus(i)}
                onFocus={() => setFocus(i)}
                onBlur={() => setFocus(null)}
              />
            ))}
          </div>
          {f ? (
            <div className={s.tip} style={{ left: `${(x(focus!) / W) * 100}%` }} role="status">
              <b>Week of {fmt(f.week)}</b>
              <span>
                <i className={s.keyA} /> Decisions <b>{f.decisions}</b>
              </span>
              <span>
                <i className={s.keyB} /> Marked ready <b>{f.markedReady}</b>
              </span>
            </div>
          ) : null}
          <p className={s.legend}>
            <span>
              <i className={s.keyA} /> Flag decisions
            </span>
            <span>
              <i className={s.keyB} /> Marked ready
            </span>
          </p>
        </div>
      )}
    </section>
  );
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
}

function hours(h: number): string {
  return h < 48 ? `${Math.round(h * 10) / 10}h` : `${Math.round((h / 24) * 10) / 10}d`;
}

const OUTCOME = [
  { key: 'accepted', label: 'Accepted', color: '#2f8a50' },
  { key: 'edited', label: 'Edited', color: '#5b7fd0' },
  { key: 'dismissed', label: 'Dismissed', color: '#9a9a92' },
] as const;

function Donut({ decided }: { decided: DashboardData['breakdown']['decided'] }) {
  const total = decided.accepted + decided.edited + decided.dismissed;
  const r = 42;
  const c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <div className={s.donutWrap}>
      <svg
        viewBox="0 0 110 110"
        className={s.donut}
        role="img"
        aria-label={OUTCOME.map((o) => `${o.label} ${decided[o.key]}`).join(', ')}
      >
        <circle cx={55} cy={55} r={r} className={s.donutTrack} />
        {total > 0
          ? OUTCOME.map((o) => {
              const len = (decided[o.key] / total) * c;
              const seg = (
                <circle
                  key={o.key}
                  cx={55}
                  cy={55}
                  r={r}
                  stroke={o.color}
                  strokeDasharray={`${Math.max(0, len - 2)} ${c}`}
                  strokeDashoffset={-offset}
                  className={s.donutSeg}
                />
              );
              offset += len;
              return seg;
            })
          : null}
        <text x={55} y={53} textAnchor="middle" className={s.donutNum}>
          {total}
        </text>
        <text x={55} y={68} textAnchor="middle" className={s.donutSub}>
          decided
        </text>
      </svg>
      <ul className={s.legendList}>
        {OUTCOME.map((o) => (
          <li key={o.key}>
            <i style={{ background: o.color }} /> {o.label}
            <b>{decided[o.key]}</b>
            <span>{total ? `${Math.round((decided[o.key] / total) * 100)}%` : '—'}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Bars({
  rows,
  empty,
}: {
  rows: { label: string; value: number; of?: number }[];
  empty: string;
}) {
  // Counts share one scale; an "x of y" row is its own share, so a full row always means all of it.
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (rows.length === 0) return <p className={s.empty}>{empty}</p>;
  return (
    <ul className={s.bars}>
      {rows.map((r, i) => (
        <li key={r.label} style={{ '--i': i } as CSSProperties}>
          <span className={s.barLabel}>{r.label}</span>
          <span className={s.barTrack}>
            <span
              className={s.barFill}
              style={{
                width: `${(r.value / (r.of !== undefined ? Math.max(1, r.of) : max)) * 100}%`,
              }}
            />
          </span>
          <b className={s.barNum}>{r.of !== undefined ? `${r.value} of ${r.of} left` : r.value}</b>
        </li>
      ))}
    </ul>
  );
}

function AnalyticsView({ data, live }: { data: DashboardData; live: boolean }) {
  const counts = { need: 0, waiting: 0, resolved: 0, ready: 0 };
  for (const r of data.queue) counts[statusOf(r)]++;
  const tickets = data.queue.length;
  const totalFlags = data.queue.reduce((a, r) => a + r.totalFlags, 0);
  const open = data.queue.reduce((a, r) => a + r.openFlags, 0);
  const decidedPct = totalFlags ? Math.round(((totalFlags - open) / totalFlags) * 100) : 0;
  const notReady = tickets - counts.ready;
  const med = median(data.readyHours);
  const sev = data.breakdown.openBySeverity;
  const sevTotal = sev.high + sev.medium + sev.low;

  const projects = new Map<string, { left: number; total: number }>();
  for (const r of data.queue) {
    const p = projects.get(r.project) ?? { left: 0, total: 0 };
    p.total++;
    if (!r.ready) p.left++;
    projects.set(r.project, p);
  }

  return (
    <>
      <header className={s.workHead}>
        <div>
          <h1 className={s.workTitle}>Ticket analytics</h1>
          <p className={s.muted}>
            {live
              ? 'Where review work stands, from each ticket’s latest version in your workspace.'
              : 'A prototype view with sample data. It is not a measurement.'}
          </p>
        </div>
        <a className={`${s.btn} ${s.btnLine}`} href="/analytics">
          Open full analytics <ArrowUpRight aria-hidden size={16} />
        </a>
      </header>

      <div className={s.kpis}>
        <section className={`${s.chartCard} ${s.kpi}`} aria-labelledby="pg-k1">
          <h2 id="pg-k1">Flags left to decide</h2>
          <p className={s.kpiNum}>
            {open} <span>of {totalFlags}</span>
          </p>
          <div
            className={s.bar}
            role="progressbar"
            aria-label="Flags decided"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={decidedPct}
          >
            <span style={{ width: `${decidedPct}%` }} />
          </div>
          <p className={s.muted}>{decidedPct}% decided by a reviewer</p>
        </section>
        <section className={`${s.chartCard} ${s.kpi}`} aria-labelledby="pg-k2">
          <h2 id="pg-k2">Tickets left to ready</h2>
          <p className={s.kpiNum}>
            {notReady} <span>of {tickets}</span>
          </p>
          <div
            className={s.stack}
            role="img"
            aria-label={(Object.keys(counts) as (keyof typeof counts)[])
              .map((k) => `${STATUS_LABEL[k]} ${counts[k]}`)
              .join(', ')}
          >
            {(Object.keys(counts) as (keyof typeof counts)[]).map((k) =>
              counts[k] > 0 ? (
                <span key={k} data-status={k} style={{ flexGrow: counts[k] }} />
              ) : null
            )}
          </div>
          <p className={s.muted}>
            {counts.need} need a decision · {counts.waiting} not analysed
          </p>
        </section>
        <section className={`${s.chartCard} ${s.kpi}`} aria-labelledby="pg-k3">
          <h2 id="pg-k3">Median time to ready</h2>
          <p className={s.kpiNum}>{med === null ? '—' : hours(med)}</p>
          <p className={s.muted}>
            {med === null
              ? 'No ticket marked ready yet.'
              : `From ingest to ready, across ${plural(data.readyHours.length, 'ticket')}${live ? '' : ' (sample)'}.`}
          </p>
        </section>
      </div>

      <div className={s.chartsGrid}>
        <section className={s.chartCard} aria-labelledby="pg-outcome-h">
          <h2 id="pg-outcome-h" className={s.h2}>
            Decisions by outcome
          </h2>
          <Donut decided={data.breakdown.decided} />
        </section>
        <section className={s.chartCard} aria-labelledby="pg-cat-h">
          <h2 id="pg-cat-h" className={s.h2}>
            Open flags by category
          </h2>
          <Bars
            rows={data.breakdown.openByCategory.map((c) => ({ label: c.label, value: c.count }))}
            empty="No open flags. Every flag has been decided."
          />
          {sevTotal > 0 ? (
            <>
              <div
                className={s.sevStack}
                role="img"
                aria-label={`High ${sev.high}, medium ${sev.medium}, low ${sev.low}`}
              >
                {sev.high ? <span data-sev="high" style={{ flexGrow: sev.high }} /> : null}
                {sev.medium ? <span data-sev="medium" style={{ flexGrow: sev.medium }} /> : null}
                {sev.low ? <span data-sev="low" style={{ flexGrow: sev.low }} /> : null}
              </div>
              <p className={s.muted}>
                By severity: {sev.high} high · {sev.medium} medium · {sev.low} low
              </p>
            </>
          ) : null}
        </section>
      </div>

      <section className={s.chartCard} aria-labelledby="pg-proj-h">
        <h2 id="pg-proj-h" className={s.h2}>
          Tickets left per project
        </h2>
        <Bars
          rows={[...projects].map(([label, p]) => ({ label, value: p.left, of: p.total }))}
          empty="No tickets yet."
        />
      </section>

      <ActivityChart weeks={data.weeks} live={live} />
    </>
  );
}

const DESIGNATION: Record<NonNullable<DashboardData['user']['role']>, string> = {
  owner: 'Owner',
  admin: 'Admin',
  reviewer: 'Reviewer',
};

/** The reviewer's photo when the account has one, otherwise a neutral avatar. */
function Avatar({ url }: { url: string | null }) {
  const [broken, setBroken] = useState(false);
  return (
    <span className={s.avatar} data-empty={!url || broken ? 'true' : undefined}>
      {url && !broken ? (
        // A plain img: the avatar host is the auth provider's and is not in next/image config.
        <img src={url} alt="" referrerPolicy="no-referrer" onError={() => setBroken(true)} />
      ) : (
        <UserRound aria-hidden strokeWidth={1.5} />
      )}
    </span>
  );
}

/** The grey profile card from the screenshot: photo or neutral avatar, name, designation, actions. */
function Profile({
  data,
  live,
  goLogin,
  onAnalytics,
}: {
  data: DashboardData;
  live: boolean;
  goLogin: () => void;
  onAnalytics: () => void;
}) {
  const u = data.user;
  const handle = u.email?.split('@')[0];
  return (
    <section className={s.profileCard} aria-labelledby="pg-profile-h">
      {live ? <AvatarEditor url={u.avatarUrl} /> : <Avatar url={null} />}
      {live ? (
        <>
          <h2 id="pg-profile-h" className={s.profileName} title={u.name ?? u.email ?? undefined}>
            {u.name ?? handle ?? u.email}
          </h2>
          {u.role ? (
            <p className={s.designation}>
              <BadgeCheck aria-hidden size={15} strokeWidth={1.75} />
              {DESIGNATION[u.role]}
              {u.workspace ? <span> · {u.workspace}</span> : null}
            </p>
          ) : null}
          <div className={s.roundBtns}>
            <a className={s.roundBtn} href="/team" aria-label="Team" title="Team">
              <Users aria-hidden />
            </a>
            <button
              type="button"
              className={s.roundBtn}
              onClick={onAnalytics}
              aria-label="Ticket analytics"
              title="Ticket analytics"
            >
              <BarChart3 aria-hidden />
            </button>
            <form action={signOut}>
              <button type="submit" className={s.roundBtn} aria-label="Sign out" title="Sign out">
                <LogOut aria-hidden />
              </button>
            </form>
          </div>
        </>
      ) : (
        <>
          <h2 id="pg-profile-h" className={s.profileName}>
            Not signed in
          </h2>
          <p className={s.muted}>Your photo and designation appear here once you sign in.</p>
          <div className={s.roundBtns}>
            <button
              type="button"
              className={s.roundBtn}
              onClick={goLogin}
              aria-label="Sign in"
              title="Sign in"
            >
              <LogIn aria-hidden />
            </button>
          </div>
        </>
      )}
    </section>
  );
}

/** The agent where the screenshot's Activity feed sits, under the same centred heading. */
function AgentPanel({
  data,
  agent,
  goLogin,
}: {
  data: DashboardData;
  agent: ReactNode;
  goLogin: () => void;
}) {
  const a = data.agent;
  return (
    <section className={s.activity} aria-labelledby="pg-agent-h">
      <h2 id="pg-agent-h" className={s.activityHead}>
        <span>Resolution agent</span>
      </h2>
      {a.ticket ? (
        <a className={s.agentTicket} href={`/tickets/${a.ticket.id}/conversation`}>
          <MessagesSquare aria-hidden size={14} /> <code>{a.ticket.key}</code> · {a.ticket.title}
          <ArrowUpRight aria-hidden size={13} />
        </a>
      ) : null}
      {a.state === 'ready' && agent ? (
        <div className={s.agentBody}>{agent}</div>
      ) : (
        <div className={s.agentEmpty}>
          <p>{AGENT_COPY[a.state]}</p>
          {a.state === 'signed-out' ? (
            <button type="button" className={`${s.btn} ${s.btnLine} ${s.btnSm}`} onClick={goLogin}>
              Sign in
            </button>
          ) : null}
        </div>
      )}
      <p className={s.agentFine}>
        The agent only drafts. Nothing is decided until you apply a draft.
      </p>
    </section>
  );
}

const AGENT_COPY: Record<DashboardData['agent']['state'], string> = {
  ready: 'The agent is loading.',
  'signed-out':
    'Sign in to talk through a ticket’s open flags with the resolution agent, one flag at a time.',
  off: 'The resolution agent is turned off in this environment (SPECFIX_RESOLUTION_AGENT is not “on”). Decide flags on a ticket’s Review tab instead.',
  locked:
    'The Conversational agent is part of Pro. On the Free plan, decide flags on a ticket’s Review tab.',
  'not-migrated':
    'The agent’s tables are not on this database yet (migration 0008). Decide flags on the Review tab until then.',
  'no-ticket':
    'No ticket is ready to discuss. The agent talks about flags only after you lock your own gap list on a ticket’s Review tab.',
  error: 'The agent could not be loaded just now. The ticket’s Conversation tab still works.',
};
