import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireUser } from '@/lib/session';
import { requireTenant } from '@/lib/tenant';
import {
  countStaleScenariosForTicket,
  coverageCounts,
  getTicket,
  latestVersion,
  listReadinessEvents,
  listScaffoldsForVersion,
  listScenarioReviewsForVersion,
  listScenariosForVersion,
  untestedResolvedFlags,
  type CoverageCounts,
  type ScaffoldRow,
  type ScenarioReviewDetailRow,
  type ScenarioRow,
  type UntestedFlag,
} from '@/lib/repos';
import { AppHeader } from '@/components/app-header';
import { TicketTabs } from '@/components/ticket-tabs';
import { Badge, Card, CardContent } from '@/components/ui';
import { TicketText } from '../stages';
import { CoveragePanel, GenerationPanel, ScenarioList, SpecsAuditTrail } from './specs';

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
  }

  const liveScenarios = scenarios.filter((s) => s.status !== 'stale');

  return (
    <>
      <AppHeader user={user} tenant={tenant} />

      <main className="mx-auto max-w-6xl px-6 py-8">
        <nav className="mb-4 text-sm text-muted-foreground">
          <Link href={`/?project=${ticket.project_id}`} className="hover:text-foreground">
            {ticket.project_name}
          </Link>
          <span className="mx-2">/</span>
          <span className="font-mono text-xs">{ticket.external_key}</span>
        </nav>

        <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
          <h1 className="text-2xl font-semibold tracking-tight">
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

        <TicketTabs ticketId={ticket.id} active="specs" />

        {error ? (
          <p className="mb-6 rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </p>
        ) : null}

        {version && staleSpecCount > 0 ? (
          <p className="mb-6 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            This ticket changed after specs were approved on an earlier version. {staleSpecCount}{' '}
            scenario{staleSpecCount === 1 ? '' : 's'} went stale — regenerate and re-review so the
            specs match the current requirement.
          </p>
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

        {version && coverage ? (
          <div className="mt-6">
            <CoveragePanel counts={coverage} untested={untested} />
          </div>
        ) : null}

        {version && reviews.length > 0 ? (
          <div className="mt-6">
            <SpecsAuditTrail reviews={reviews} />
          </div>
        ) : null}
      </main>
    </>
  );
}
