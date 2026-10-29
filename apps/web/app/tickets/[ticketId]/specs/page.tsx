import { notFound } from 'next/navigation';
import { requireUser } from '@/lib/session';
import { requireTenant } from '@/lib/tenant';
import { agentAccess } from '@/lib/plan';
import { buildClauseCoverage, isApprovedScenario, type ClauseCoverageRow } from '@specfix/shared';
import {
  clauseCoverage,
  clauseEmbeddingsAvailable,
  countStaleScenariosForTicket,
  coverageCounts,
  driftedScenarios,
  getTicket,
  latestVersion,
  listProjects,
  listReadinessEvents,
  listScaffoldsForVersion,
  listScenarioReviewsForVersion,
  listScenariosForVersion,
  latestCiForTicket,
  type ScenarioCiRow,
  untestedResolvedFlags,
  type CoverageCounts,
  type DriftedScenario,
  type ScaffoldRow,
  type ScenarioReviewDetailRow,
  type ScenarioRow,
  type UntestedFlag,
} from '@/lib/repos';
import { AppShell, Breadcrumb } from '@/components/app-shell';
import { TicketTabs } from '@/components/ticket-tabs';
import { Badge, Card, CardContent, Notice } from '@/components/ui';
import { TicketText } from '../stages';
import {
  CoveragePanel,
  DriftPanel,
  GenerationPanel,
  ScenarioList,
  SpecsAuditTrail,
  type SemanticState,
} from './specs';
import { CiPanel } from './ci-panel';

/**
 * The Specs tab: compile Gherkin scenarios from the approved requirement, then review
 * each one. Generation is gated on the version being marked ready — the same sign-off
 * the Review tab produces — so this page shows the gate when a ticket is not there yet
 * rather than offering a button that would fail.
 */
export default async function SpecsPage({
  params,
  searchParams,
}: {
  params: Promise<{ ticketId: string }>;
  searchParams: Promise<{ error?: string; edit?: string; editScaffold?: string }>;
}) {
  const { ticketId } = await params;
  const { error, edit, editScaffold } = await searchParams;

  const user = await requireUser();
  const tenant = await requireTenant(user.id);

  // The project list feeds the sidebar; it reads no ticket data.
  const [ticket, projects] = await Promise.all([
    getTicket(tenant.tenant_id, ticketId),
    listProjects(tenant.tenant_id),
  ]);
  if (!ticket) notFound();

  const version = await latestVersion(tenant.tenant_id, ticket.id);

  let ready = false;
  let scenarios: ScenarioRow[] = [];
  let scaffolds: ScaffoldRow[] = [];
  let reviews: ScenarioReviewDetailRow[] = [];
  let resolvedFlagCount = 0;
  let coverage: CoverageCounts | null = null;
  let untested: UntestedFlag[] = [];
  let staleSpecCount = 0;
  let clauseRows: ClauseCoverageRow[] = [];
  let semanticState: SemanticState = 'schema_missing';
  let drift: DriftedScenario[] = [];
  let ci: ScenarioCiRow[] = [];

  if (version) {
    const events = await listReadinessEvents(tenant.tenant_id, ticket.id);
    ready = events.some((e) => e.event === 'marked_ready' && e.ticket_version_id === version.id);
    scenarios = await listScenariosForVersion(tenant.tenant_id, version.id);
    ci = await latestCiForTicket(tenant.tenant_id, ticket.id);
    scaffolds = await listScaffoldsForVersion(tenant.tenant_id, version.id);
    reviews = await listScenarioReviewsForVersion(tenant.tenant_id, version.id);
    coverage = await coverageCounts(tenant.tenant_id, version.id);
    untested = await untestedResolvedFlags(tenant.tenant_id, version.id);
    staleSpecCount = await countStaleScenariosForTicket(tenant.tenant_id, ticket.id);
    resolvedFlagCount = coverage.resolvedFlags;

    // Clause coverage: the exact part needs nothing but the AC text and the accepted
    // scenarios, so it always renders. The semantic part reads clause vectors
    // (migration 0006); if those are unavailable or the query fails, the panel says so
    // and the page still works.
    const accepted = scenarios
      .filter((s) => isApprovedScenario(s.status))
      .map((s) => ({ id: s.id, title: s.title, coversAc: s.covers_ac }));
    let semantic: Awaited<ReturnType<typeof clauseCoverage>> | null = null;
    try {
      if (await clauseEmbeddingsAvailable()) {
        semantic = await clauseCoverage(tenant.tenant_id, version.id);
        semanticState = semantic.length > 0 ? 'ready' : 'not_embedded';
        if (staleSpecCount > 0) {
          drift = await driftedScenarios(tenant.tenant_id, {
            ticketId: ticket.id,
            currentVersionId: version.id,
          });
        }
      }
    } catch (error) {
      console.error('[coverage] semantic coverage unavailable', {
        ticketId: ticket.id,
        error: error instanceof Error ? error.message : String(error),
      });
      semantic = null;
      semanticState = 'error';
    }
    clauseRows = buildClauseCoverage(version.acceptance_criteria_text, accepted, semantic);
  }

  const liveScenarios = scenarios.filter((s) => s.status !== 'stale');

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
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-[-0.012em]">
          {version?.title ?? ticket.title}
        </h1>
        {version ? (
          ready ? (
            <Badge tone="success">Ready for dev</Badge>
          ) : (
            <Badge tone="muted">Not signed off</Badge>
          )
        ) : null}
      </div>

      <TicketTabs
        ticketId={ticket.id}
        active="specs"
        agent={await agentAccess(user, tenant.tenant_id)}
      />

      {error ? (
        <Notice tone="error" className="mb-6">
          {error}
        </Notice>
      ) : null}

      {version && staleSpecCount > 0 ? (
        <Notice tone="warning" className="mb-6">
          This ticket changed after specs were approved on an earlier version. {staleSpecCount}{' '}
          scenario{staleSpecCount === 1 ? '' : 's'} went stale — regenerate and re-review so the
          specs match the current requirement.
        </Notice>
      ) : null}

      {version && drift.length > 0 ? (
        <div className="mb-6">
          <DriftPanel drifted={drift} />
        </div>
      ) : null}

      {!version ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            This ticket has no captured version yet, so there is nothing to compile. Versions are
            created on ingest.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
          <div className="lg:sticky lg:top-6 lg:self-start">
            <TicketText version={version} />
          </div>

          <div className="space-y-6">
            <GenerationPanel
              ticketId={ticket.id}
              ready={ready}
              hasScenarios={liveScenarios.length > 0}
              resolvedFlagCount={resolvedFlagCount}
            />
            <ScenarioList
              ticketId={ticket.id}
              scenarios={scenarios}
              editingScenarioId={edit}
              scaffolds={scaffolds}
              editingScaffoldId={editScaffold}
            />
          </div>
        </div>
      )}

      {version ? (
        <div className="mt-6">
          <CiPanel scenarios={scenarios} rows={ci} />
        </div>
      ) : null}

      {version && coverage ? (
        <div className="mt-6">
          <CoveragePanel
            counts={coverage}
            untested={untested}
            clauses={clauseRows}
            semanticState={semanticState}
          />
        </div>
      ) : null}

      {version && reviews.length > 0 ? (
        <div className="mt-6">
          <SpecsAuditTrail reviews={reviews} />
        </div>
      ) : null}
    </AppShell>
  );
}
