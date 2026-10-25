import { notFound } from 'next/navigation';
import { requireUser } from '@/lib/session';
import { currentMemberships, requireTenant } from '@/lib/tenant';
import { buildClauseCoverage, isApprovedScenario, type ClauseCoverageRow } from '@specfix/shared';
import {
  clauseCoverage,
  clauseEmbeddingsAvailable,
  countStaleScenariosForTicket,
  coverageCounts,
  driftedScenarios,
  getTicket,
  latestVersion,
  listReadinessEvents,
  listScaffoldsForVersion,
  listScenarioReviewsForVersion,
  listScenariosForVersion,
  untestedResolvedFlags,
  type CoverageCounts,
  type DriftedScenario,
  type ScaffoldRow,
  type ScenarioReviewDetailRow,
  type ScenarioRow,
  type UntestedFlag,
} from '@/lib/repos';
import { AppHeader } from '@/components/app-header';
import { TicketHeader } from '@/components/ticket-tabs';
import { Badge, Card, CardContent, ErrorBanner } from '@/components/ui';
import { TicketText } from '../stages';
import {
  CoveragePanel,
  DriftPanel,
  GenerationPanel,
  ScenarioList,
  SpecsAuditTrail,
  type SemanticState,
} from './specs';

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
  const memberships = await currentMemberships(user.id);
  const tenant = await requireTenant(user.id, memberships);

  const ticket = await getTicket(tenant.tenant_id, ticketId);
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

  if (version) {
    const events = await listReadinessEvents(tenant.tenant_id, ticket.id);
    ready = events.some((e) => e.event === 'marked_ready' && e.ticket_version_id === version.id);
    scenarios = await listScenariosForVersion(tenant.tenant_id, version.id);
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

  const approvedCount = liveScenarios.filter((s) => isApprovedScenario(s.status)).length;
  const meta = version
    ? [
        ready ? 'Signed off for development' : 'Not signed off yet',
        `${liveScenarios.length} ${liveScenarios.length === 1 ? 'scenario' : 'scenarios'}`,
        `${approvedCount} accepted`,
      ].join(' · ')
    : 'No captured version';

  return (
    <>
      <AppHeader user={user} tenant={tenant} memberships={memberships} active="queue" />

      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        <TicketHeader
          ticketId={ticket.id}
          projectId={ticket.project_id}
          projectName={ticket.project_name}
          externalKey={ticket.external_key}
          title={version?.title ?? ticket.title}
          meta={meta}
          active="specs"
          badges={
            version ? (
              ready ? (
                <Badge tone="success">Ready for dev</Badge>
              ) : (
                <Badge tone="muted">Not signed off</Badge>
              )
            ) : null
          }
        />

        <ErrorBanner message={error} />

        {version && staleSpecCount > 0 ? (
          <p className="mb-6 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            This ticket changed after specs were approved on an earlier version. {staleSpecCount}{' '}
            scenario{staleSpecCount === 1 ? '' : 's'} went stale — regenerate and re-review so the
            specs match the current requirement.
          </p>
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
          <div className="space-y-6">
            <GenerationPanel
              ticketId={ticket.id}
              ready={ready}
              hasScenarios={liveScenarios.length > 0}
              resolvedFlagCount={resolvedFlagCount}
            />

            <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
              <ScenarioList
                ticketId={ticket.id}
                scenarios={scenarios}
                editingScenarioId={edit}
                scaffolds={scaffolds}
                editingScaffoldId={editScaffold}
              />
              <div className="space-y-6 lg:sticky lg:top-20 lg:self-start">
                {coverage ? (
                  <CoveragePanel
                    counts={coverage}
                    untested={untested}
                    clauses={clauseRows}
                    semanticState={semanticState}
                  />
                ) : null}
                <TicketText version={version} />
              </div>
            </div>

            {reviews.length > 0 ? <SpecsAuditTrail reviews={reviews} /> : null}
          </div>
        )}
      </main>
    </>
  );
}
