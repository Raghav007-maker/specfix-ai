/**
 * The requirement -> scenario -> scaffold traceability graph.
 *
 * Coverage is a query here, not a guess. The one distinction this module keeps sharp:
 * a link the compiler inferred while compiling and a link a human drew are not the same
 * strength of evidence, so `created_by` is recorded and the coverage queries report the
 * two separately rather than summing them into one number.
 *
 * Milestone D adds the embedding-backed fuzzy coverage and drift views on top of these
 * tables; this module is the exact-link layer they build on.
 */
import { query, type TenantId } from '../client.ts';

export type LinkType =
  'requirement_to_scenario' | 'scenario_to_scaffold' | 'requirement_to_scaffold';

export interface TraceabilityLinkRow {
  id: string;
  tenant_id: string;
  ticket_version_id: string;
  flag_id: string | null;
  scenario_id: string | null;
  scaffold_id: string | null;
  link_type: LinkType;
  created_by: 'compiler' | 'human';
  user_id: string | null;
  created_at: Date;
}

export async function listLinksForVersion(
  tenantId: TenantId,
  ticketVersionId: string
): Promise<TraceabilityLinkRow[]> {
  return query<TraceabilityLinkRow>(
    `select id, tenant_id, ticket_version_id, flag_id, scenario_id, scaffold_id,
            link_type, created_by, user_id, created_at
     from traceability_links
     where tenant_id = $1 and ticket_version_id = $2
     order by created_at`,
    [tenantId, ticketVersionId]
  );
}

/** A human-drawn link. The compiler's links are written by the compile/emit paths. */
export async function addHumanLink(
  tenantId: TenantId,
  input: {
    ticketVersionId: string;
    flagId?: string | null;
    scenarioId?: string | null;
    scaffoldId?: string | null;
    linkType: LinkType;
    userId: string;
  }
): Promise<TraceabilityLinkRow> {
  const [row] = await query<TraceabilityLinkRow>(
    `insert into traceability_links (
       tenant_id, ticket_version_id, flag_id, scenario_id, scaffold_id, link_type, created_by, user_id
     ) values ($1, $2, $3, $4, $5, $6, 'human', $7)
     returning id, tenant_id, ticket_version_id, flag_id, scenario_id, scaffold_id,
               link_type, created_by, user_id, created_at`,
    [
      tenantId,
      input.ticketVersionId,
      input.flagId ?? null,
      input.scenarioId ?? null,
      input.scaffoldId ?? null,
      input.linkType,
      input.userId,
    ]
  );
  if (!row) throw new Error('traceability_links insert returned no row');
  return row;
}

export async function removeLink(tenantId: TenantId, linkId: string): Promise<void> {
  await query(`delete from traceability_links where tenant_id = $1 and id = $2`, [
    tenantId,
    linkId,
  ]);
}

/**
 * Coverage inputs for one ticket version: how many acceptance-criteria-level
 * requirements have at least one accepted scenario, and how many have a scaffold.
 *
 * "Accepted" means the scenario is approved or edited. Drafts do not count — a coverage
 * number that includes unreviewed generator output would overstate coverage in exactly
 * the direction that makes the product look better than it is.
 */
export interface CoverageCounts {
  /** Resolved flags on this version — the requirement-side denominator. */
  resolvedFlags: number;
  /** Resolved flags with at least one accepted scenario linked. */
  flagsWithScenario: number;
  /** Accepted scenarios on this version. */
  acceptedScenarios: number;
  /** Accepted scenarios with an emitted scaffold. */
  scenariosWithScaffold: number;
}

export async function coverageCounts(
  tenantId: TenantId,
  ticketVersionId: string
): Promise<CoverageCounts> {
  const [row] = await query<{
    resolved_flags: string;
    flags_with_scenario: string;
    accepted_scenarios: string;
    scenarios_with_scaffold: string;
  }>(
    `select
       (select count(*) from flags f
         where f.tenant_id = $1 and f.ticket_version_id = $2
           and f.status in ('accepted', 'edited'))::text as resolved_flags,
       (select count(distinct t.flag_id) from traceability_links t
         where t.tenant_id = $1 and t.ticket_version_id = $2
           and t.flag_id is not null
           and t.scenario_id in (
             select s.id from scenarios s
             where s.tenant_id = $1 and s.status in ('approved', 'edited')))::text as flags_with_scenario,
       (select count(*) from scenarios s
         where s.tenant_id = $1 and s.ticket_version_id = $2
           and s.status in ('approved', 'edited'))::text as accepted_scenarios,
       (select count(distinct t.scenario_id) from traceability_links t
         where t.tenant_id = $1 and t.ticket_version_id = $2
           and t.link_type = 'scenario_to_scaffold'
           and t.scaffold_id is not null)::text as scenarios_with_scaffold`,
    [tenantId, ticketVersionId]
  );

  return {
    resolvedFlags: Number(row?.resolved_flags ?? 0),
    flagsWithScenario: Number(row?.flags_with_scenario ?? 0),
    acceptedScenarios: Number(row?.accepted_scenarios ?? 0),
    scenariosWithScaffold: Number(row?.scenarios_with_scaffold ?? 0),
  };
}

/**
 * Resolved flags on this version with no accepted scenario covering them — the gaps the
 * coverage view surfaces as "still untested". A flag is covered when a
 * requirement→scenario link points at a scenario the reviewer accepted; a link to a
 * draft or dismissed scenario does not count, for the same reason draft scenarios do
 * not count toward coverage.
 */
export interface UntestedFlag {
  flagId: string;
  category: string;
  question: string;
}

export async function untestedResolvedFlags(
  tenantId: TenantId,
  ticketVersionId: string
): Promise<UntestedFlag[]> {
  const rows = await query<{ flag_id: string; category: string; question: string }>(
    `select f.id as flag_id, f.category,
            coalesce(f.edited_question, f.question_for_pm) as question
     from flags f
     where f.tenant_id = $1 and f.ticket_version_id = $2 and f.status in ('accepted', 'edited')
       and not exists (
         select 1 from traceability_links t
         join scenarios s on s.id = t.scenario_id and s.tenant_id = t.tenant_id
         where t.tenant_id = f.tenant_id and t.flag_id = f.id
           and t.link_type = 'requirement_to_scenario'
           and s.status in ('approved', 'edited')
       )
     order by f.created_at`,
    [tenantId, ticketVersionId]
  );
  return rows.map((r) => ({ flagId: r.flag_id, category: r.category, question: r.question }));
}
