import type { Metadata } from 'next';
import Link from 'next/link';
import { FLAG_CATEGORY_LABELS } from '@specfix/shared';
import { requireUser } from '@/lib/session';
import { requireTenant } from '@/lib/tenant';
import {
  flagBreakdown,
  listProjects,
  ticketQueue,
  timeToReady,
  weeklyActivity,
  type TicketQueueRow,
  type WeeklyActivity,
} from '@/lib/repos';
import { AppShell } from '@/components/app-shell';
import { cn } from '@/lib/cn';

export const metadata: Metadata = { title: 'Ticket analytics · SpecFix' };

type Status = 'need' | 'resolved' | 'ready' | 'waiting';

const STATUS: Record<Status, { label: string; swatch: string }> = {
  need: { label: 'Need decisions', swatch: 'bg-text/80' },
  resolved: { label: 'Flags resolved, not ready', swatch: 'bg-teal/70' },
  ready: { label: 'Ready for development', swatch: 'bg-positive' },
  waiting: { label: 'Not analysed yet', swatch: 'bg-control' },
};

/** The same grouping the review queue uses. */
function statusOf(r: TicketQueueRow): Status {
  if (!r.analyzed) return 'waiting';
  if (r.ready) return 'ready';
  return r.open_flags > 0 ? 'need' : 'resolved';
}

/**
 * Ticket analytics: where review work stands across the workspace and where it slows down.
 * Everything comes from tenant-scoped reads: the review queue per project, the flag breakdown
 * and weekly activity aggregates, and time-to-ready from the readiness events.
 */
export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string }>;
}) {
  const [user, { project: projectParam }] = await Promise.all([requireUser(), searchParams]);
  const tenant = await requireTenant(user.id);
  const projects = await listProjects(tenant.tenant_id);

  const [queues, breakdown, weeks, ttr] = await Promise.all([
    Promise.all(projects.map((p) => ticketQueue(tenant.tenant_id, p.id))),
    flagBreakdown(tenant.tenant_id),
    weeklyActivity(tenant.tenant_id, 12),
    timeToReady(tenant.tenant_id),
  ]);
  const byProject = projects.map((p, i) => ({ project: p, rows: queues[i] ?? [] }));
  const scoped = byProject.find((x) => x.project.id === projectParam);
  const rows = scoped ? scoped.rows : byProject.flatMap((x) => x.rows);

  const count = countStatuses(rows);
  const totalFlags = rows.reduce((s, r) => s + r.total_flags, 0);
  const openFlags = rows.reduce((s, r) => s + r.open_flags, 0);
  const decidedFlags = totalFlags - openFlags;

  return (
    <AppShell
      user={user}
      tenant={tenant}
      projects={projects}
      current="analytics"
      breadcrumb={
        <p className="flex min-w-0 items-center gap-2 text-sm">
          <span className="truncate text-muted-foreground">{tenant.tenant_name}</span>
          <span aria-hidden className="text-muted-foreground">
            /
          </span>
          <span className="truncate">Ticket analytics</span>
        </p>
      }
    >
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-[-0.012em]">Ticket analytics</h1>
          <p className="mt-1 max-w-[62ch] text-sm text-muted-foreground">
            Where review work stands in {tenant.tenant_name}, and where it slows down. Counts use
            each ticket’s latest version.
          </p>
        </div>
        {projects.length > 1 ? (
          <nav
            aria-label="Scope"
            className="inline-flex max-w-full overflow-x-auto rounded-lg bg-frame p-[3px] shadow-[inset_0_1px_2px_rgb(0_0_0/0.5),0_0_0_1px_rgb(var(--border))]"
          >
            <ScopeLink href="/analytics" active={!scoped}>
              All projects
            </ScopeLink>
            {projects.map((p) => (
              <ScopeLink key={p.id} href={`/analytics?project=${p.id}`} active={scoped?.project.id === p.id}>
                {p.name}
              </ScopeLink>
            ))}
          </nav>
        ) : null}
      </div>

      {rows.length === 0 ? (
        <p className="mt-6 rounded-xl border border-dashed border-border px-5 py-10 text-center text-sm text-muted-foreground">
          No tickets {scoped ? `in ${scoped.project.name}` : 'in this workspace'} yet. Analytics
          appear once tickets are ingested and analysed.
        </p>
      ) : (
        <>
          {/* summary: one instrument strip */}
          <dl className="mt-6 grid grid-cols-2 overflow-hidden rounded-xl border border-border bg-raised/60 shadow-[inset_0_1px_0_rgb(255_255_255/0.05),0_24px_48px_-24px_rgb(0_0_0/0.7)] md:grid-cols-5">
            <Figure label="Tickets" value={rows.length} />
            <Figure label="Need decisions" value={count.need} note={`${openFlags} open ${openFlags === 1 ? 'flag' : 'flags'}`} />
            <Figure label="Not analysed" value={count.waiting} note="Waiting on the worker" />
            <Figure label="Ready for development" value={count.ready} note={`${pct(count.ready, rows.length)}% of tickets`} />
            <Figure
              label="Flags decided"
              value={totalFlags ? `${pct(decidedFlags, totalFlags)}%` : '—'}
              note={totalFlags ? `${decidedFlags} of ${totalFlags} on latest versions` : 'No flags yet'}
              wide
            />
          </dl>

          <div className="mt-5 grid gap-5 xl:grid-cols-12">
            <Panel title="Tickets by review status" className="xl:col-span-5">
              <div role="img" aria-label={(Object.keys(STATUS) as Status[]).map((k) => `${STATUS[k].label} ${count[k]}`).join(', ')} className="mt-4 flex h-3 gap-0.5 overflow-hidden rounded-[3px]">
                {(Object.keys(STATUS) as Status[]).map((k) =>
                  count[k] ? <span key={k} className={STATUS[k].swatch} style={{ flex: count[k] }} /> : null
                )}
              </div>
              <table className="mt-3 w-full text-[13.5px]">
                <tbody>
                  {(Object.keys(STATUS) as Status[]).map((k) => (
                    <tr key={k} className="border-t border-rule">
                      <td className="py-2">
                        <span aria-hidden className={cn('mr-2.5 inline-block h-[9px] w-[9px] rounded-[2px] align-[-1px]', STATUS[k].swatch)} />
                        {STATUS[k].label}
                      </td>
                      <td className="py-2 text-right tabular-nums">{count[k]}</td>
                      <td className="w-14 py-2 text-right tabular-nums text-muted-foreground">{pct(count[k], rows.length)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>

            <Panel title="By project" note="Select a project to open its queue" className="xl:col-span-7">
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-[13.5px] tabular-nums">
                  <thead>
                    <tr className="text-xs text-muted-foreground">
                      <th className="py-2 pr-3 text-left font-normal">Project</th>
                      <th className="px-3 py-2 text-right font-normal">Tickets</th>
                      <th className="px-3 py-2 text-right font-normal max-sm:hidden">Not analysed</th>
                      <th className="px-3 py-2 text-right font-normal">Need decisions</th>
                      <th className="px-3 py-2 text-right font-normal">Ready</th>
                      <th className="py-2 pl-3 text-right font-normal">Decided</th>
                    </tr>
                  </thead>
                  <tbody>
                    {byProject.map(({ project, rows: pr }) => {
                      const c = countStatuses(pr);
                      const t = pr.reduce((s, r) => s + r.total_flags, 0);
                      const o = pr.reduce((s, r) => s + r.open_flags, 0);
                      const d = t ? pct(t - o, t) : null;
                      return (
                        <tr key={project.id} className="border-t border-rule">
                          <td className="py-2.5 pr-3">
                            <Link href={`/?project=${project.id}`} className="rounded-sm font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal">
                              {project.name}
                            </Link>
                          </td>
                          <td className="px-3 py-2.5 text-right">{pr.length}</td>
                          <td className="px-3 py-2.5 text-right max-sm:hidden">{c.waiting}</td>
                          <td className="px-3 py-2.5 text-right">{c.need}</td>
                          <td className="px-3 py-2.5 text-right">{c.ready}</td>
                          <td className="py-2.5 pl-3 text-right">
                            {d === null ? (
                              <span className="text-muted-foreground">—</span>
                            ) : (
                              <span className="inline-flex items-center gap-2.5">
                                <span aria-hidden className="h-1 w-16 overflow-hidden rounded-full bg-active max-sm:hidden">
                                  <span className="block h-full bg-text/70" style={{ width: `${d}%` }} />
                                </span>
                                {d}%
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Panel>

            <Panel title="Open findings" note="Across the workspace, latest versions" className="xl:col-span-6">
              {breakdown.openByCategory.length === 0 ? (
                <p className="mt-4 text-sm text-muted-foreground">No open flags right now.</p>
              ) : (
                <>
                  <Bars
                    rows={[
                      { label: 'High', value: breakdown.openBySeverity.high, tone: 'bg-negative' },
                      { label: 'Medium', value: breakdown.openBySeverity.medium, tone: 'bg-warning' },
                      { label: 'Low', value: breakdown.openBySeverity.low, tone: 'bg-muted-foreground' },
                    ]}
                  />
                  <p className="mt-4 text-[12.5px] text-muted-foreground">By category</p>
                  <Bars
                    rows={breakdown.openByCategory.map((c) => ({
                      label: (FLAG_CATEGORY_LABELS as Record<string, string>)[c.category] ?? c.category,
                      value: c.count,
                      tone: 'bg-control',
                    }))}
                  />
                </>
              )}
            </Panel>

            <Panel title="How reviewers decided" note="Decided flags on latest versions" className="xl:col-span-6">
              <Outcomes decided={breakdown.decided} />
              <TimeToReadyFigures rows={ttr} />
            </Panel>

            <Panel title="Review activity, last 12 weeks" note="Weeks start on Monday, UTC" className="xl:col-span-12">
              <div className="mt-4 grid gap-8 md:grid-cols-2">
                <WeekColumns weeks={weeks} pick={(w) => w.decisions} tone="bg-text/70" legend="Flag decisions" />
                <WeekColumns
                  weeks={weeks}
                  pick={(w) => w.markedReady}
                  outlined={(w) => w.markedReadyBackfilled}
                  tone="bg-positive"
                  legend="Tickets marked ready"
                />
              </div>
            </Panel>
          </div>
        </>
      )}
    </AppShell>
  );
}

function countStatuses(rows: TicketQueueRow[]): Record<Status, number> {
  const c: Record<Status, number> = { need: 0, resolved: 0, ready: 0, waiting: 0 };
  for (const r of rows) c[statusOf(r)] += 1;
  return c;
}

function pct(part: number, whole: number): number {
  return whole ? Math.round((part / whole) * 100) : 0;
}

function ScopeLink({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'inline-flex h-7 items-center whitespace-nowrap rounded-md px-3 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal max-sm:h-10',
        active
          ? 'bg-active text-text shadow-[inset_0_1px_0_rgb(255_255_255/0.06),0_0_0_1px_rgb(var(--control))]'
          : 'text-muted-foreground hover:text-text'
      )}
    >
      {children}
    </Link>
  );
}

function Figure({ label, value, note, wide }: { label: string; value: number | string; note?: string; wide?: boolean }) {
  return (
    <div className={cn('border-rule px-4 py-4 [&:not(:first-child)]:border-l max-md:border-t max-md:[&:nth-child(odd)]:border-l-0', wide && 'max-md:col-span-2')}>
      <dt className="text-[12.5px] text-muted-foreground">{label}</dt>
      <dd className="mt-2 text-[26px] font-medium leading-none tracking-[-0.02em] tabular-nums">{value}</dd>
      {note ? <p className="mt-1.5 text-xs text-muted-foreground">{note}</p> : null}
    </div>
  );
}

function Panel({ title, note, className, children }: { title: string; note?: string; className?: string; children: React.ReactNode }) {
  return (
    <section aria-label={title} className={cn('min-w-0 rounded-xl border border-border bg-frame/50 p-5 shadow-[inset_0_1px_0_rgb(255_255_255/0.03)]', className)}>
      <h2 className="text-[14.5px] font-semibold">{title}</h2>
      {note ? <p className="mt-0.5 text-xs text-muted-foreground">{note}</p> : null}
      {children}
    </section>
  );
}

function Bars({ rows }: { rows: { label: string; value: number; tone: string }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="mt-3 space-y-1.5">
      {rows.map((r) => (
        <li key={r.label} className="grid grid-cols-[minmax(0,150px)_minmax(0,1fr)_32px] items-center gap-3 text-[13.5px] max-sm:grid-cols-[minmax(0,110px)_minmax(0,1fr)_28px]">
          <span className="truncate text-text/85">{r.label}</span>
          <span aria-hidden className="h-2 overflow-hidden rounded-[2px] bg-active">
            <span className={cn('block h-full rounded-[2px]', r.tone)} style={{ width: `${(r.value / max) * 100}%` }} />
          </span>
          <span className="text-right tabular-nums">{r.value}</span>
        </li>
      ))}
    </ul>
  );
}

function Outcomes({ decided }: { decided: { accepted: number; edited: number; dismissed: number } }) {
  const total = decided.accepted + decided.edited + decided.dismissed;
  const parts = [
    { label: 'Accepted', value: decided.accepted, tone: 'bg-positive' },
    { label: 'Edited', value: decided.edited, tone: 'bg-teal/70' },
    { label: 'Dismissed', value: decided.dismissed, tone: 'bg-control' },
  ];
  if (total === 0) return <p className="mt-4 text-sm text-muted-foreground">No flags decided yet.</p>;
  return (
    <>
      <div role="img" aria-label={parts.map((p) => `${p.label} ${p.value}`).join(', ')} className="mt-4 flex h-3 gap-0.5 overflow-hidden rounded-[3px]">
        {parts.map((p) => (p.value ? <span key={p.label} className={p.tone} style={{ flex: p.value }} /> : null))}
      </div>
      <table className="mt-3 w-full text-[13.5px]">
        <tbody>
          {parts.map((p) => (
            <tr key={p.label} className="border-t border-rule">
              <td className="py-2">
                <span aria-hidden className={cn('mr-2.5 inline-block h-[9px] w-[9px] rounded-[2px] align-[-1px]', p.tone)} />
                {p.label}
              </td>
              <td className="py-2 text-right tabular-nums">{p.value}</td>
              <td className="w-14 py-2 text-right tabular-nums text-muted-foreground">{pct(p.value, total)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function TimeToReadyFigures({ rows }: { rows: { hours: number; backfilled: boolean }[] }) {
  if (rows.length === 0) {
    return <p className="mt-5 text-[13px] text-muted-foreground">No ticket has gone from ingest to ready yet, so there is no time to ready to show.</p>;
  }
  const sorted = rows.map((r) => r.hours).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  const p75 = sorted[Math.ceil(0.75 * sorted.length) - 1]!;
  const backfilled = rows.filter((r) => r.backfilled).length;
  return (
    <>
      <dl className="mt-5 flex flex-wrap gap-x-8 gap-y-3">
        <div>
          <dt className="text-[12.5px] text-muted-foreground">Median time to ready</dt>
          <dd className="mt-1.5 text-2xl font-medium tabular-nums">{hoursLabel(median)}</dd>
        </div>
        <div>
          <dt className="text-[12.5px] text-muted-foreground">75th percentile</dt>
          <dd className="mt-1.5 text-2xl font-medium tabular-nums">{hoursLabel(p75)}</dd>
        </div>
        <div>
          <dt className="text-[12.5px] text-muted-foreground">Tickets measured</dt>
          <dd className="mt-1.5 text-2xl font-medium tabular-nums">{rows.length}</dd>
        </div>
      </dl>
      <p className="mt-3 text-xs text-muted-foreground">
        From ingest to “marked ready”.
        {backfilled ? ` Includes ${backfilled} ${backfilled === 1 ? 'ticket' : 'tickets'} with history backfilled from Jira.` : ''}
      </p>
    </>
  );
}

function hoursLabel(h: number): string {
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
  return h >= 48 ? `${(h / 24).toFixed(1)} d` : `${Math.round(h)} h`;
}

/** Weekly columns: square bars on a zero line, three gridlines, round ticks above the maximum. */
function WeekColumns({
  weeks,
  pick,
  outlined,
  tone,
  legend,
}: {
  weeks: WeeklyActivity[];
  pick: (w: WeeklyActivity) => number;
  outlined?: (w: WeeklyActivity) => number;
  tone: string;
  legend: string;
}) {
  const values = weeks.map(pick);
  const top = Math.max(4, (Math.floor(Math.max(...values) / 2) + 1) * 2);
  const total = values.reduce((s, v) => s + v, 0);
  return (
    <figure className="min-w-0 pt-2">
      <div className="grid grid-cols-[24px_minmax(0,1fr)] gap-2">
        <div aria-hidden className="relative h-36 text-right text-[11px] tabular-nums text-muted-foreground">
          {[0, 0.5, 1].map((f) => (
            <span key={f} className="absolute right-0 translate-y-1/2 leading-none" style={{ bottom: `${f * 100}%` }}>
              {Math.round(top * f)}
            </span>
          ))}
        </div>
        <div className="relative h-36 border-b border-control">
          {[0.5, 1].map((f) => (
            <span key={f} aria-hidden className="absolute inset-x-0 border-t border-rule" style={{ bottom: `${f * 100}%` }} />
          ))}
          <ol className="relative flex h-full items-end gap-[6%] px-[2%]">
            {weeks.map((w, i) => {
              const v = values[i] ?? 0;
              const ghost = outlined ? outlined(w) : 0;
              return (
                <li key={w.week} className="flex h-full flex-1 items-end" title={`Week of ${w.week}: ${v}`}>
                  {v > 0 ? (
                    <span
                      className={cn('block w-full', ghost === v ? 'border border-positive bg-transparent' : tone)}
                      style={{ height: `${(v / top) * 100}%` }}
                    />
                  ) : null}
                  <span className="sr-only">{`Week of ${w.week}: ${v}`}</span>
                </li>
              );
            })}
          </ol>
        </div>
        <span />
        <div aria-hidden className="flex px-[2%] text-[11px] text-muted-foreground">
          {weeks.map((w, i) => (
            <span key={w.week} className="flex-1 whitespace-nowrap text-center">
              {i % 3 === 0 ? shortDate(w.week) : ''}
            </span>
          ))}
        </div>
      </div>
      <figcaption className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className={cn('h-[9px] w-[9px] rounded-[2px]', tone)} />
          {legend} · {total} in 12 weeks
        </span>
        {outlined ? (
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="h-[9px] w-[9px] rounded-[2px] border border-positive" />
            Backfilled from Jira
          </span>
        ) : null}
      </figcaption>
    </figure>
  );
}

function shortDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}
