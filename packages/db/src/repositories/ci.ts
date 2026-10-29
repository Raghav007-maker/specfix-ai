/**
 * CI results (Phase 3): per-project tokens, received runs, and per-scenario outcomes.
 *
 * resolveCiToken is the one cross-tenant read: a CI job identifies itself only by its
 * token, and the token decides the tenant and project. Everything after is scoped by
 * those. Results for scenarios outside the token's project are dropped (and counted as
 * unmatched), so a token for one project cannot write results onto another's tickets.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { tx, query, type TenantId } from '../client.ts';
import { JiraConnectionError, requireTenantAdmin } from './jira.ts';
import { enqueueJob } from './jobs.ts';

export class CiTokenError extends Error {}

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Postgres int4 upper bound: durations are clamped into the column's range. */
const MAX_DURATION_MS = 2_147_483_647;

/** Text from CI made storable: NUL and other control characters removed, then capped. */
function clean(value: string | null | undefined, max: number): string | null {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const stripped = value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
  return stripped ? stripped.slice(0, max) : null;
}

function clampDuration(ms: number): number {
  return Number.isFinite(ms) ? Math.min(MAX_DURATION_MS, Math.max(0, Math.round(ms))) : 0;
}

async function requireCiAdmin(client: PoolClient, tenantId: TenantId, actorId: string) {
  await requireTenantAdmin(client, tenantId, actorId).catch((error) => {
    throw error instanceof JiraConnectionError
      ? new CiTokenError('Only an owner or admin can manage CI tokens.')
      : error;
  });
}

export interface CiTokenRow {
  project_id: string;
  token_prefix: string;
  created_at: Date;
  last_used_at: Date | null;
}

/**
 * Issues a new token for the project, revoking the previous one. Returns the token in
 * plain text — the only time it exists outside the CI secret store.
 */
export async function createCiToken(
  tenantId: TenantId,
  actorId: string,
  projectId: string
): Promise<string> {
  if (!UUID.test(projectId)) throw new CiTokenError('No such project.');
  const token = `sfci_${randomBytes(32).toString('base64url')}`;
  await tx(async (client) => {
    await requireCiAdmin(client, tenantId, actorId);
    // Locking the project row serializes concurrent "create token" clicks, so the
    // revoke-then-insert below never races another one into the one-live-token index.
    const project = await client.query(
      `select 1 from projects where tenant_id = $1 and id = $2 for update`,
      [tenantId, projectId]
    );
    if (!project.rowCount) throw new CiTokenError('No such project.');
    await client.query(
      `update ci_tokens set revoked_at = now()
       where tenant_id = $1 and project_id = $2 and revoked_at is null`,
      [tenantId, projectId]
    );
    await client.query(
      `insert into ci_tokens (tenant_id, project_id, token_hash, token_prefix, created_by)
       values ($1, $2, $3, $4, $5)`,
      [tenantId, projectId, hashToken(token), token.slice(0, 12), actorId]
    );
  });
  return token;
}

export async function revokeCiToken(
  tenantId: TenantId,
  actorId: string,
  projectId: string
): Promise<void> {
  if (!UUID.test(projectId)) throw new CiTokenError('No such project.');
  await tx(async (client) => {
    await requireCiAdmin(client, tenantId, actorId);
    await client.query(
      `update ci_tokens set revoked_at = now()
       where tenant_id = $1 and project_id = $2 and revoked_at is null`,
      [tenantId, projectId]
    );
  });
}

export async function listCiTokens(tenantId: TenantId): Promise<CiTokenRow[]> {
  return query<CiTokenRow>(
    `select project_id, token_prefix, created_at, last_used_at from ci_tokens
     where tenant_id = $1 and revoked_at is null`,
    [tenantId]
  );
}

/**
 * The tenant and project a CI token belongs to, or null for an unknown or revoked one.
 * Read-only: `last_used_at` is set by recordCiRun, so a rejected request does not count
 * as a use.
 */
export async function resolveCiToken(
  token: string
): Promise<{ tenant_id: string; project_id: string; token_hash: string } | null> {
  if (!/^sfci_[A-Za-z0-9_-]{20,}$/.test(token)) return null;
  const hash = hashToken(token);
  const [row] = await query<{ tenant_id: string; project_id: string }>(
    `select tenant_id, project_id from ci_tokens where token_hash = $1 and revoked_at is null`,
    [hash]
  );
  return row ? { ...row, token_hash: hash } : null;
}

export interface CiResultInput {
  scenarioId: string;
  status: 'passed' | 'failed' | 'flaky' | 'skipped';
  durationMs: number;
  error: string | null;
}

export interface RecordedCiRun {
  runId: string;
  matched: number;
  unmatched: number;
  /**
   * Tickets where an approved scenario has newly started failing (its previous result was
   * not a failure), for notifications. A scenario that keeps failing run after run, or a
   * draft/dismissed one, does not notify again. Only default-branch runs notify: a PR's
   * failures are reported on the PR.
   */
  failedTickets: Array<{ ticket_id: string; failed: number; total: number }>;
  /** Whether this run sets the tickets' CI status (it ran on the default branch). */
  onDefaultBranch: boolean;
  /** The linked PR this run belongs to, when SpecFix knows it. */
  pullRequestId: string | null;
}

interface RunPlacement {
  repositoryId: string | null;
  pullRequestId: string | null;
  /** The PR number when known but the PR itself is not stored yet. */
  pullNumber: number | null;
  onDefaultBranch: boolean;
  installationActive: boolean;
}

/**
 * Where a run belongs: which mapped repository, which PR, and whether it ran on the
 * repository's default branch.
 *
 * The repository is the one CI named (`repository`, i.e. $GITHUB_REPOSITORY) among the
 * project's mapped repositories, or the project's only mapped repository. A PR is found
 * by its number (CI's `pullRequest`, or a `<n>/merge` ref as GitHub Actions reports for
 * pull_request events), else by the head commit, else by an open PR from the branch.
 *
 * Without a mapped repository the default branch is assumed to be main or master; a run
 * with no branch at all keeps counting, as it did before branches were considered.
 */
async function placeRun(
  client: PoolClient,
  tenantId: TenantId,
  projectId: string,
  input: {
    commitSha: string | null;
    branch: string | null;
    repository: string | null;
    pullRequest: number | null;
  }
): Promise<RunPlacement> {
  const repos = (
    await client.query<{
      id: string;
      full_name: string;
      default_branch: string;
      active: boolean;
    }>(
      `select r.id, r.full_name, r.default_branch, i.suspended_at is null as active
       from github_repositories r
       join github_installations i
         on i.installation_id = r.installation_id and i.tenant_id = r.tenant_id
       where r.tenant_id = $1 and r.project_id = $2`,
      [tenantId, projectId]
    )
  ).rows;
  const named = input.repository?.toLowerCase() ?? null;
  const repo = named
    ? (repos.find((r) => r.full_name.toLowerCase() === named) ?? null)
    : repos.length === 1
      ? repos[0]!
      : null;

  const mergeRef = input.branch ? /^(\d{1,9})\/merge$/.exec(input.branch) : null;
  const pullNumber =
    input.pullRequest && Number.isSafeInteger(input.pullRequest) && input.pullRequest > 0
      ? input.pullRequest
      : mergeRef
        ? Number(mergeRef[1])
        : null;

  let pullRequestId: string | null = null;
  if (repo) {
    const found = pullNumber
      ? await client.query<{ id: string }>(
          `select id from github_pull_requests
           where tenant_id = $1 and repository_id = $2 and number = $3`,
          [tenantId, repo.id, pullNumber]
        )
      : await client.query<{ id: string }>(
          `select id from github_pull_requests
           where tenant_id = $1 and repository_id = $2
             and (head_sha = $3 or (state = 'open' and head_ref = $4))
           order by (head_sha = $3) desc, (state = 'open') desc, updated_at desc
           limit 1`,
          [tenantId, repo.id, input.commitSha ?? '', input.branch ?? '']
        );
    pullRequestId = found.rows[0]?.id ?? null;
  }

  let onDefaultBranch: boolean;
  if (pullNumber || pullRequestId) onDefaultBranch = false;
  else if (!input.branch) onDefaultBranch = true;
  else if (repo) onDefaultBranch = input.branch === repo.default_branch;
  else if (repos.length > 0) onDefaultBranch = repos.some((r) => r.default_branch === input.branch);
  else onDefaultBranch = input.branch === 'main' || input.branch === 'master';

  return {
    repositoryId: repo?.id ?? null,
    pullRequestId,
    pullNumber: pullRequestId ? null : pullNumber,
    onDefaultBranch,
    installationActive: repo?.active ?? false,
  };
}

export async function recordCiRun(
  tenantId: TenantId,
  projectId: string,
  input: {
    commitSha: string | null;
    branch: string | null;
    runUrl: string | null;
    results: readonly CiResultInput[];
    unmatched: number;
    /** The token that sent the run; marked used once the run is stored. */
    tokenHash?: string;
    /** "owner/name" of the repository CI ran in ($GITHUB_REPOSITORY), when sent. */
    repository?: string | null;
    /** The PR number CI ran for, when sent. */
    pullRequest?: number | null;
  }
): Promise<RecordedCiRun> {
  return tx(async (client) => {
    const commitSha = clean(input.commitSha, 64);
    const branch = clean(input.branch, 200);
    const placement = await placeRun(client, tenantId, projectId, {
      commitSha,
      branch,
      repository: clean(input.repository ?? null, 201),
      pullRequest: input.pullRequest ?? null,
    });
    const ids = input.results.map((r) => r.scenarioId).filter((id) => UUID.test(id));
    const known = await client.query<{
      id: string;
      ticket_id: string;
      approved: boolean;
      was_failing: boolean;
    }>(
      `select s.id, s.ticket_id, s.status in ('approved', 'edited') as approved,
              coalesce((select r.status = 'failed' from ci_results r
                        join ci_runs cr on cr.id = r.ci_run_id
                        where r.tenant_id = s.tenant_id and r.scenario_id = s.id
                          and cr.on_default_branch
                        order by cr.received_at desc limit 1), false) as was_failing
       from scenarios s
       join tickets t on t.id = s.ticket_id and t.tenant_id = s.tenant_id
       where s.tenant_id = $1 and t.project_id = $2 and s.id = any($3::uuid[])`,
      [tenantId, projectId, ids]
    );
    const info = new Map(known.rows.map((r) => [r.id, r]));
    const ticketOf = new Map(known.rows.map((r) => [r.id, r.ticket_id]));
    const kept = input.results.filter((r) => ticketOf.has(r.scenarioId));
    const count = (s: CiResultInput['status']) => kept.filter((r) => r.status === s).length;

    const run = await client.query<{ id: string }>(
      `insert into ci_runs (tenant_id, project_id, commit_sha, branch, run_url, total, passed,
                            failed, flaky, skipped, unmatched, repository_id, pull_request_id,
                            on_default_branch)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       returning id`,
      [
        tenantId,
        projectId,
        commitSha,
        branch,
        safeRunUrl(input.runUrl),
        kept.length,
        count('passed'),
        count('failed'),
        count('flaky'),
        count('skipped'),
        input.unmatched + (input.results.length - kept.length),
        placement.repositoryId,
        placement.pullRequestId,
        placement.onDefaultBranch,
      ]
    );
    const runId = run.rows[0]!.id;
    // One statement for the whole run, not one round-trip per scenario.
    if (kept.length > 0) {
      await client.query(
        `insert into ci_results (tenant_id, ci_run_id, scenario_id, status, duration_ms, error)
         select $1, $2, r.scenario_id, r.status, r.duration_ms, r.error
         from unnest($3::uuid[], $4::text[], $5::int[], $6::text[])
           as r(scenario_id, status, duration_ms, error)`,
        [
          tenantId,
          runId,
          kept.map((r) => r.scenarioId),
          kept.map((r) => r.status),
          kept.map((r) => clampDuration(r.durationMs)),
          kept.map((r) => clean(r.error, 500)),
        ]
      );
    }

    if (input.tokenHash) {
      await client.query(`update ci_tokens set last_used_at = now() where token_hash = $1`, [
        input.tokenHash,
      ]);
    }

    // The PR's "SpecFix acceptance" check is published by the worker, queued in the same
    // transaction as the run so a stored run always gets its check. A PR SpecFix has not
    // seen yet (CI finished before the webhook arrived) is fetched first; that job then
    // attaches this run and publishes the check.
    if (placement.installationActive && placement.pullRequestId) {
      await enqueueJob(
        tenantId,
        {
          kind: 'github_check_run',
          payload: { pullRequestId: placement.pullRequestId },
          dedupeKey: `gh-check:${placement.pullRequestId}:${runId}`,
          maxAttempts: 4,
        },
        client
      );
    } else if (placement.installationActive && placement.repositoryId && placement.pullNumber) {
      await enqueueJob(
        tenantId,
        {
          kind: 'github_pr_sync',
          payload: { repositoryId: placement.repositoryId, number: placement.pullNumber },
          dedupeKey: `gh-pr:${placement.repositoryId}:${placement.pullNumber}`,
          maxAttempts: 4,
        },
        client
      );
    }

    // Only approved scenarios count, and a ticket notifies only when one of them newly
    // fails on the default branch — repeated failures, drafts and PR runs stay quiet.
    const perTicket = new Map<string, { failed: number; total: number; newly: number }>();
    for (const r of placement.onDefaultBranch ? kept : []) {
      const sc = info.get(r.scenarioId)!;
      if (!sc.approved) continue;
      const entry = perTicket.get(sc.ticket_id) ?? { failed: 0, total: 0, newly: 0 };
      entry.total += 1;
      if (r.status === 'failed') {
        entry.failed += 1;
        if (!sc.was_failing) entry.newly += 1;
      }
      perTicket.set(sc.ticket_id, entry);
    }
    return {
      runId,
      matched: kept.length,
      unmatched: input.unmatched + (input.results.length - kept.length),
      failedTickets: [...perTicket.entries()]
        .filter(([, v]) => v.newly > 0)
        .map(([ticket_id, v]) => ({ ticket_id, failed: v.failed, total: v.total })),
      onDefaultBranch: placement.onDefaultBranch,
      pullRequestId: placement.pullRequestId,
    };
  });
}

export interface ScenarioCiRow {
  scenario_id: string;
  status: CiResultInput['status'];
  error: string | null;
  commit_sha: string | null;
  branch: string | null;
  run_url: string | null;
  received_at: Date;
}

/**
 * Each scenario's latest result on the default branch: the ticket's CI status. Runs on
 * feature branches and PRs never overwrite it; they are shown per PR instead.
 */
export async function latestCiForTicket(
  tenantId: TenantId,
  ticketId: string
): Promise<ScenarioCiRow[]> {
  return query<ScenarioCiRow>(
    `select distinct on (r.scenario_id)
            r.scenario_id, r.status, r.error, cr.commit_sha, cr.branch, cr.run_url, cr.received_at
     from ci_results r
     join ci_runs cr on cr.id = r.ci_run_id
     join scenarios s on s.id = r.scenario_id and s.tenant_id = r.tenant_id
     where r.tenant_id = $1 and s.ticket_id = $2 and cr.on_default_branch
     order by r.scenario_id, cr.received_at desc`,
    [tenantId, ticketId]
  );
}

export interface CiRunRow {
  project_id: string;
  commit_sha: string | null;
  branch: string | null;
  total: number;
  passed: number;
  failed: number;
  flaky: number;
  skipped: number;
  unmatched: number;
  received_at: Date;
}

export async function latestCiRuns(tenantId: TenantId): Promise<CiRunRow[]> {
  return query<CiRunRow>(
    `select distinct on (project_id) project_id, commit_sha, branch, total, passed, failed,
            flaky, skipped, unmatched, received_at
     from ci_runs where tenant_id = $1 and on_default_branch
     order by project_id, received_at desc`,
    [tenantId]
  );
}

/** Only an https URL with a host is kept as the "open run" link. */
function safeRunUrl(value: string | null | undefined): string | null {
  const text = clean(value, 500);
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === 'https:' && url.hostname ? url.toString().slice(0, 500) : null;
  } catch {
    return null;
  }
}
