import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireUser } from '@/lib/session';
import { requireTenant } from '@/lib/tenant';
import {
  findSession,
  getTicket,
  latestVersion,
  listDecisionsForTicket,
  listGaps,
  listRunsForTicket,
  readinessTimeline,
  revealedFlags,
  type FlagRow,
  type ReadinessTimelineRow,
  type ReviewerGapRow,
  type TicketDecisionRow,
} from '@/lib/repos';
import { AppHeader } from '@/components/app-header';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from '@/components/ui';
import { beginReview } from './actions';
import { AuditTrail, BlindGapStage, MarkReady, ReviewStage, TicketText } from './stages';

/**
 * One ticket, reviewed under the blind-first protocol.
 *
 * The ordering rule this page exists to honour: until the reviewer's own gap list is
 * locked, this render performs no read against the flags table — not the flags, not
 * their count, not the decision history that quotes them. The repository layer refuses
 * to hand flags over early (revealedFlags throws), but the stronger guarantee is that
 * nothing on the pre-lock path even asks. A reviewer cannot be anchored by output that
 * was never fetched.
 */
export default async function TicketPage({
  params,
  searchParams,
}: {
  params: Promise<{ ticketId: string }>;
  searchParams: Promise<{ error?: string; edit?: string }>;
}) {
  const { ticketId } = await params;
  const { error, edit } = await searchParams;

  const user = await requireUser();
  const tenant = await requireTenant(user.id);

  const ticket = await getTicket(tenant.tenant_id, ticketId);
  if (!ticket) notFound();

  const version = await latestVersion(tenant.tenant_id, ticket.id);

  const session = version ? await findSession(tenant.tenant_id, version.id, user.id) : null;
  const locked = session !== null && session.gaps_locked_at !== null;

  // Everything below is fetched only on the branch that is allowed to see it.
  let gaps: ReviewerGapRow[] = [];
  let flags: FlagRow[] = [];
  let decisions: TicketDecisionRow[] = [];
  let timeline: ReadinessTimelineRow[] = [];
  let analyzed = false;

  if (session) {
    gaps = await listGaps(tenant.tenant_id, session.id);
  }

  if (session && locked) {
    const revealed = await revealedFlags(tenant.tenant_id, session.id);
    flags = revealed.flags;
    decisions = await listDecisionsForTicket(tenant.tenant_id, ticket.id);
    timeline = await readinessTimeline(tenant.tenant_id, ticket.id);

    const runs = await listRunsForTicket(tenant.tenant_id, ticket.id);
    analyzed = runs.some((r) => r.ticket_version_id === version?.id && r.status === 'succeeded');
  }

  const openFlags = flags.filter((f) => f.status === 'open').length;
  const ready = timeline.some(
    (e) => e.event === 'marked_ready' && e.ticket_version_id === version?.id
  );

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
          {locked ? (
            <div className="flex items-center gap-2">
              {ready ? <Badge tone="success">Ready for dev</Badge> : null}
              {openFlags > 0 ? (
                <Badge tone="warning">
                  {openFlags} open {openFlags === 1 ? 'flag' : 'flags'}
                </Badge>
              ) : null}
            </div>
          ) : null}
        </div>

        {error ? (
          <p className="mb-6 rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </p>
        ) : null}

        {!version ? (
          <NoVersion />
        ) : (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
            <div className="lg:sticky lg:top-6 lg:self-start">
              <TicketText version={version} />
            </div>

            <div className="space-y-6">
              {!session ? (
                <StartReview ticketId={ticket.id} />
              ) : !locked ? (
                <BlindGapStage ticketId={ticket.id} session={session} gaps={gaps} />
              ) : (
                <ReviewStage
                  ticketId={ticket.id}
                  session={session}
                  gaps={gaps}
                  flags={flags}
                  analyzed={analyzed}
                  editingFlagId={edit}
                />
              )}
            </div>
          </div>
        )}

        {locked ? (
          <div className="mt-6 space-y-6">
            <MarkReady ticketId={ticket.id} openFlags={openFlags} ready={ready} />
            <AuditTrail decisions={decisions} timeline={timeline} />
          </div>
        ) : null}
      </main>
    </>
  );
}

function StartReview({ ticketId }: { ticketId: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Blind-first review</CardTitle>
        <p className="text-sm text-muted-foreground">
          You review this ticket before you see what the model found. First you write your own list
          of the places a developer would have to guess; then you lock it; only then are the
          model&rsquo;s flags revealed.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          The order matters. If you read the model&rsquo;s flags first, your own list is anchored to
          them and the recall number stops meaning anything — it would measure agreement, not
          coverage.
        </p>
        <form action={beginReview}>
          <input type="hidden" name="ticketId" value={ticketId} />
          <Button type="submit">Start blind review</Button>
        </form>
      </CardContent>
    </Card>
  );
}

function NoVersion() {
  return (
    <Card>
      <CardContent className="py-10 text-center text-sm text-muted-foreground">
        This ticket has no captured version yet, so there is nothing to review. Versions are created
        on ingest.
      </CardContent>
    </Card>
  );
}
