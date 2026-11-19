import type { CostEstimate } from '@specfix/sync';
import type { JobRow } from '@/lib/repos';
import { AutoRefresh } from '@/components/auto-refresh';
import { ConfirmSubmit } from '@/components/confirm-dialog';
import { analyzeProjectAction } from '@/app/actions';

/**
 * The spec queue's analysis state for one project, and the admin's button to start a batch.
 * Analysis spends money, so the button names the batch size and the estimated cost, and asks
 * for confirmation before anything is queued.
 */
export function AnalysisPanel({
  projectId,
  job,
  candidates,
  batchLimit,
  estimate,
  budget,
  isAdmin,
}: {
  projectId: string;
  job: JobRow | null;
  candidates: number;
  batchLimit: number;
  /** Null when analysis cannot run on this server (no model configured). */
  estimate: CostEstimate | null;
  budget: { used: number; cap: number };
  isAdmin: boolean;
}) {
  const analyzing = job?.status === 'queued' || job?.status === 'running';
  const batch = Math.min(candidates, batchLimit);
  const waitingTooLong =
    job?.status === 'queued' && Date.now() - +new Date(job.created_at) > 60_000;

  return (
    <section
      aria-label="Analysis"
      className="mb-4 space-y-3 rounded-xl border border-border bg-raised px-4 py-3 text-sm"
    >
      {analyzing ? <AutoRefresh /> : null}
      <Summary job={job} />
      {analyzing ? null : candidates === 0 ? (
        <p className="text-muted-foreground">
          No ticket is waiting for analysis. Send a story or task for spec review from its page.
        </p>
      ) : estimate === null ? (
        <p className="text-muted-foreground">
          {candidates} ticket(s) are waiting, but no analysis model is configured on this server.
        </p>
      ) : !estimate.priced ? (
        <p className="text-negative-ink">
          Analysis is off: the model <code>{estimate.model}</code> has no known price, so its spend
          could not be tracked.
        </p>
      ) : (
        <p className="text-muted-foreground">
          <span className="font-medium text-text">{candidates}</span> ticket(s) waiting.
          {candidates > batch ? ` The next batch takes ${batch}.` : null} Estimated cost{' '}
          <span className="font-medium text-text">{usd(estimate.perTicketUsd * batch)}</span> on{' '}
          <code>{estimate.model}</code>
          {estimate.basis === 'default' ? ' (rough: no runs yet to estimate from)' : null}.
        </p>
      )}
      {waitingTooLong ? (
        <p className="text-xs text-warning-ink">
          Still waiting to start. Batches run in the background worker — is it running?
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          AI usage this month: {budget.used.toLocaleString('en-US')} of{' '}
          {budget.cap.toLocaleString('en-US')} tokens.
        </p>
        {isAdmin && estimate?.priced && batch > 0 && !analyzing ? (
          <ConfirmSubmit
            action={analyzeProjectAction}
            fields={{ projectId }}
            label={`Analyze ${batch} ticket(s)`}
            pendingLabel="Queueing…"
            title={`Analyze ${batch} ticket(s)?`}
            body={`This calls ${estimate.model} once per ticket, about ${usd(estimate.perTicketUsd * batch)} in total. The batch stops early if the workspace reaches its monthly token cap or the batch reaches its spending limit. Tickets already analyzed are never charged again.`}
            confirmLabel="Start analysis"
            variant="outline"
          />
        ) : null}
      </div>
    </section>
  );
}

function Summary({ job }: { job: JobRow | null }) {
  if (!job) return null;
  const p = job.progress as {
    total?: number;
    analyzed?: number;
    failed?: number;
    flags?: number;
    costUsd?: number;
    stopped?: string | null;
  };
  if (job.status === 'queued') return <p>Analysis queued.</p>;
  if (job.status === 'running') {
    return (
      <p>
        Analyzing… {p.analyzed ?? 0}
        {p.total ? ` of ${p.total}` : ''} done.
      </p>
    );
  }
  if (job.status === 'failed') {
    return <p className="text-negative-ink">Last analysis failed: {job.last_error}</p>;
  }
  const stopped =
    p.stopped === 'token_cap'
      ? ' Stopped early: the workspace reached its monthly token cap.'
      : p.stopped === 'batch_budget'
        ? ' Stopped early: the batch reached its spending limit.'
        : '';
  return (
    <p>
      Last analysis: {p.analyzed ?? 0} analyzed
      {p.failed ? `, ${p.failed} failed` : ''}, {p.flags ?? 0} flag(s), {usd(p.costUsd ?? 0)}.
      {stopped}
    </p>
  );
}

function usd(n: number): string {
  if (n > 0 && n < 0.01) return '< $0.01';
  return `$${n.toFixed(2)}`;
}
