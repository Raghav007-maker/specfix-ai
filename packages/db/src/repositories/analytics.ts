import { query, type TenantId } from '../client.ts';

/**
 * Read-only aggregates for the Ticket analytics page. Every query filters each table it
 * touches on tenant_id = $1; nothing here writes.
 *
 * Counts follow the review queue's rules: flags are read on each ticket's latest version
 * only, and stale flags (superseded text) are excluded, so a re-ingested ticket never
 * double-counts.
 */

export interface FlagBreakdown {
  /** Open flags by severity. */
  openBySeverity: { high: number; medium: number; low: number };
  /** Open flags by category, most first. */
  openByCategory: { category: string; count: number }[];
  /** Decided flags by outcome. */
  decided: { accepted: number; edited: number; dismissed: number };
}

export async function flagBreakdown(tenantId: TenantId): Promise<FlagBreakdown> {
  const rows = await query<{ status: string; severity: string; category: string; n: number }>(
    `with latest as (
       select distinct on (v.ticket_id) v.ticket_id, v.id as version_id
       from ticket_versions v
       where v.tenant_id = $1
       order by v.ticket_id, v.captured_at desc
     )
     select f.status, f.severity, f.category, count(*)::int as n
     from flags f
     join latest l on l.version_id = f.ticket_version_id
     where f.tenant_id = $1 and f.status <> 'stale'
     group by f.status, f.severity, f.category`,
    [tenantId]
  );

  const result: FlagBreakdown = {
    openBySeverity: { high: 0, medium: 0, low: 0 },
    openByCategory: [],
    decided: { accepted: 0, edited: 0, dismissed: 0 },
  };
  const byCategory = new Map<string, number>();
  for (const r of rows) {
    if (r.status === 'open') {
      if (r.severity === 'high' || r.severity === 'medium' || r.severity === 'low') {
        result.openBySeverity[r.severity] += r.n;
      }
      byCategory.set(r.category, (byCategory.get(r.category) ?? 0) + r.n);
    } else if (r.status === 'accepted' || r.status === 'edited' || r.status === 'dismissed') {
      result.decided[r.status] += r.n;
    }
  }
  result.openByCategory = [...byCategory]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));
  return result;
}

export interface WeeklyActivity {
  /** Monday of the week, ISO date (UTC). */
  week: string;
  /** Flag decisions recorded that week (accept, edit, dismiss, reopen). */
  decisions: number;
  /** Tickets marked ready that week, live and backfilled from Jira history. */
  markedReady: number;
  markedReadyBackfilled: number;
}

/** The last `weeks` weeks of review activity, oldest first, including empty weeks. */
export async function weeklyActivity(tenantId: TenantId, weeks = 12): Promise<WeeklyActivity[]> {
  return query<WeeklyActivity>(
    `with weeks as (
       select generate_series(
         date_trunc('week', now() at time zone 'utc') - make_interval(weeks => $2::int - 1),
         date_trunc('week', now() at time zone 'utc'),
         interval '1 week'
       ) as week
     ),
     decisions as (
       select date_trunc('week', d.created_at at time zone 'utc') as week, count(*)::int as n
       from flag_decisions d
       where d.tenant_id = $1
       group by 1
     ),
     ready as (
       select date_trunc('week', e.occurred_at at time zone 'utc') as week,
              count(*) filter (where not e.backfilled)::int as live,
              count(*) filter (where e.backfilled)::int as backfilled
       from readiness_events e
       where e.tenant_id = $1 and e.event = 'marked_ready'
       group by 1
     )
     select to_char(w.week, 'YYYY-MM-DD') as week,
            coalesce(d.n, 0) as decisions,
            coalesce(r.live, 0) + coalesce(r.backfilled, 0) as "markedReady",
            coalesce(r.backfilled, 0) as "markedReadyBackfilled"
     from weeks w
     left join decisions d on d.week = w.week
     left join ready r on r.week = w.week
     order by w.week`,
    [tenantId, weeks]
  );
}
