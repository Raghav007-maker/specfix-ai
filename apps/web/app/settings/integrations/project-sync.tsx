import type { CostEstimate } from '@specfix/sync';
import type { JobRow, ProjectRow } from '@/lib/repos';
import { Pill, type PillTone } from '@/components/ui';
import { SubmitButton } from '@/components/submit-button';
import { ConfirmSubmit } from '@/components/confirm-dialog';
import { analyzeAction, startImportAction } from './actions';

/**
 * One Jira project's import and analysis state, with the admin's two buttons.
 *
 * Importing is free to start. Analysis spends money, so its button names the batch
 * size and the estimated cost, and asks for confirmation before queueing anything.
 */
export function ProjectSync({
  project,
  backfill,
  analysis,
  candidates,
  batchLimit,
  estimate,
  isAdmin,
}: {
  project: ProjectRow;
  backfill: JobRow | undefined;
  analysis: JobRow | undefined;
  candidates: number;
  batchLimit: number;
  /** Null when analysis cannot run on this server (no model configured). */
  estimate: CostEstimate | null;
  isAdmin: boolean;
}) {
  const importing = backfill?.status === 'queued' || backfill?.status === 'running';
  const analyzing = analysis?.status === 'queued' || analysis?.status === 'running';
  const imported = backfill?.status === 'done';
  const waitingTooLong =
    (backfill?.status === 'queued' || analysis?.status === 'queued') &&
    Date.now() - Math.max(+(backfill?.created_at ?? 0), +(analysis?.created_at ?? 0)) > 60_000;
  const batch = Math.min(candidates, batchLimit);

  return (
    <li className="space-y-3 px-4 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="min-w-0 truncate text-sm">
          <span className="font-mono text-[13px]">{project.jira_project_key}</span>
          <span className="text-muted-foreground"> · {project.name}</span>
        </span>
        <ImportPill job={backfill} />
      </div>

      <ImportDetail job={backfill} />

      {waitingTooLong ? (
        <p className="text-xs text-warning-ink">
          Still waiting to start. Jobs run in the background worker — is <code>npm run worker</code>{' '}
          running?
        </p>
      ) : null}

      {backfill ? (
        <div className="rounded-lg border border-border bg-raised px-3 py-3 text-sm">
          <AnalysisSummary job={analysis} />
          {analyzing ? null : candidates === 0 ? (
            <p className="text-muted-foreground">No tickets in this project need analysis.</p>
          ) : estimate === null ? (
            <p className="text-muted-foreground">
              {candidates} ticket(s) qualify, but no analysis model is configured on this server.
            </p>
          ) : !estimate.priced ? (
            <p className="text-negative-ink">
              Analysis is off: the model <code>{estimate.model}</code> has no known price, so its
              spend could not be tracked.
            </p>
          ) : (
            <p className="text-muted-foreground">
              <span className="font-medium text-text">{candidates}</span> open, recently updated
              ticket(s) qualify.
              {candidates > batch ? ` The next batch takes ${batch}.` : null} Estimated cost{' '}
              <span className="font-medium text-text">{usd(estimate.perTicketUsd * batch)}</span> on{' '}
              <code>{estimate.model}</code>
              {estimate.basis === 'default' ? ' (rough: no runs yet to estimate from)' : null}.
            </p>
          )}
        </div>
      ) : null}

      {isAdmin ? (
        <div className="flex flex-wrap gap-3">
          <form action={startImportAction}>
            <input type="hidden" name="projectId" value={project.id} />
            <SubmitButton
              variant={imported ? 'outline' : 'default'}
              size="sm"
              disabled={importing}
              pendingLabel="Queueing…"
            >
              {importing ? 'Importing…' : imported ? 'Import again' : 'Import tickets'}
            </SubmitButton>
          </form>
          {estimate?.priced && batch > 0 && !analyzing && !importing ? (
            <ConfirmSubmit
              action={analyzeAction}
              fields={{ projectId: project.id }}
              label={`Analyze ${batch} ticket(s)`}
              pendingLabel="Queueing…"
              title={`Analyze ${batch} ticket(s)?`}
              body={`This calls ${estimate.model} once per ticket, about ${usd(estimate.perTicketUsd * batch)} in total. The batch stops early if the workspace reaches its monthly token cap or the batch reaches its spending limit. Tickets already analyzed are never charged again.`}
              confirmLabel="Start analysis"
              variant="outline"
            />
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function ImportPill({ job }: { job: JobRow | undefined }) {
  const [tone, label]: [PillTone, string] = !job
    ? ['neutral', 'Not imported']
    : job.status === 'queued'
      ? ['accent', 'Import queued']
      : job.status === 'running'
        ? ['accent', 'Importing']
        : job.status === 'failed'
          ? ['negative', 'Import failed']
          : ['positive', 'Imported'];
  return <Pill tone={tone}>{label}</Pill>;
}

function ImportDetail({ job }: { job: JobRow | undefined }) {
  if (!job) return null;
  const p = job.progress as { seen?: number; newVersions?: number; unchanged?: number };
  const parts: string[] = [];
  if (p.seen !== undefined) parts.push(`${p.seen} issue(s) read`);
  if (p.newVersions) parts.push(`${p.newVersions} new or changed`);
  if (p.unchanged) parts.push(`${p.unchanged} unchanged`);
  return (
    <div className="space-y-1 text-xs text-muted-foreground">
      {parts.length > 0 ? <p>{parts.join(' · ')}</p> : null}
      {job.finished_at && job.status === 'done' ? (
        <p>Finished {job.finished_at.toLocaleString('en-GB')}</p>
      ) : null}
      {job.last_error && job.status !== 'done' ? (
        <p className="text-negative-ink">{job.last_error}</p>
      ) : null}
    </div>
  );
}

function AnalysisSummary({ job }: { job: JobRow | undefined }) {
  if (!job) return null;
  const p = job.progress as {
    total?: number;
    analyzed?: number;
    failed?: number;
    flags?: number;
    costUsd?: number;
    stopped?: string | null;
  };
  if (job.status === 'queued') return <p className="mb-2">Analysis queued.</p>;
  if (job.status === 'running') {
    return (
      <p className="mb-2">
        Analyzing… {p.analyzed ?? 0}
        {p.total ? ` of ${p.total}` : ''} done.
      </p>
    );
  }
  if (job.status === 'failed') {
    return <p className="mb-2 text-negative-ink">Last analysis failed: {job.last_error}</p>;
  }
  const stopped =
    p.stopped === 'token_cap'
      ? ' Stopped early: the workspace reached its monthly token cap.'
      : p.stopped === 'batch_budget'
        ? ' Stopped early: the batch reached its spending limit.'
        : '';
  return (
    <p className="mb-2">
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
