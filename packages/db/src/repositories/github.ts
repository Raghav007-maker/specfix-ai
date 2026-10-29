/**
 * GitHub App integration: installations, their repositories and repo → project mapping,
 * pull requests linked to tickets, check runs, and the "Open PR with scaffolds" claim.
 *
 * The rules this module carries:
 *
 *   - An installation belongs to exactly one workspace. Only an owner or admin attaches
 *     one (after the callback has proven they can see it on GitHub), maps repositories,
 *     disconnects, or opens a scaffold PR; the role is re-read inside the writing
 *     transaction.
 *   - installationForWebhook is the one cross-tenant read: a delivery names only its
 *     installation id, which decides the tenant. Everything after is scoped by it, and a
 *     repository is only resolved through that same installation, so a delivery cannot
 *     reach another workspace's repository by naming its id.
 *   - Installation tokens are encrypted here (../crypto.ts) and refreshed under a row
 *     lock, so concurrent jobs mint one token, not one each. This package stays free of
 *     HTTP: callers pass the function that mints a token, posts a comment, etc.
 */
import type { PoolClient, QueryResultRow } from 'pg';
import { getPool, query, tx, type TenantId } from '../client.ts';
import { decryptSecret, encryptSecret, tokenKeyId } from '../crypto.ts';
import { enqueueJob } from './jobs.ts';
import { JiraConnectionError, requireTenantAdmin } from './jira.ts';

export class GithubConnectionError extends Error {}

type Db = Pick<PoolClient, 'query'>;

async function rows<T extends QueryResultRow>(
  db: Db,
  sql: string,
  params: readonly unknown[]
): Promise<T[]> {
  return (await db.query<T>(sql, params as unknown[])).rows;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function requireGithubAdmin(client: PoolClient, tenantId: TenantId, actorId: string) {
  await requireTenantAdmin(client, tenantId, actorId).catch((error) => {
    throw error instanceof JiraConnectionError
      ? new GithubConnectionError('Only an owner or admin can manage the GitHub connection.')
      : error;
  });
}

// ---------------------------------------------------------------------------
// Installations and repositories
// ---------------------------------------------------------------------------

export interface GithubInstallationRow {
  id: string;
  installation_id: string;
  account_login: string;
  account_type: string;
  repository_selection: string;
  suspended_at: Date | null;
  installed_by_email: string | null;
  created_at: Date;
}

export interface GithubRepoInput {
  repoId: number;
  fullName: string;
  defaultBranch: string;
}

export interface GithubRepositoryRow {
  id: string;
  installation_id: string;
  repo_id: string;
  full_name: string;
  default_branch: string;
  project_id: string | null;
}

/**
 * Attaches an installation to the workspace with the repositories it can reach. An
 * installation already attached to another workspace is refused — the first workspace
 * keeps it until it disconnects.
 */
export async function saveGithubInstallation(
  tenantId: TenantId,
  actorId: string,
  input: {
    installationId: number;
    accountLogin: string;
    accountType: string;
    repositorySelection: string;
    repos: readonly GithubRepoInput[];
  }
): Promise<void> {
  await tx(async (client) => {
    await requireGithubAdmin(client, tenantId, actorId);
    const [existing] = await rows<{ tenant_id: string }>(
      client,
      `select tenant_id from github_installations where installation_id = $1 for update`,
      [input.installationId]
    );
    if (existing && existing.tenant_id !== tenantId) {
      throw new GithubConnectionError(
        'This GitHub installation is already connected to another SpecFix workspace.'
      );
    }
    await client.query(
      `insert into github_installations
         (tenant_id, installation_id, account_login, account_type, repository_selection,
          installed_by)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (installation_id) do update set
         account_login = excluded.account_login,
         account_type = excluded.account_type,
         repository_selection = excluded.repository_selection,
         suspended_at = null,
         updated_at = now()`,
      [
        tenantId,
        input.installationId,
        input.accountLogin.slice(0, 100),
        input.accountType.slice(0, 40),
        input.repositorySelection === 'all' ? 'all' : 'selected',
        actorId,
      ]
    );
    await syncRepos(client, tenantId, input.installationId, input.repos);
  });
}

/**
 * Replaces the installation's repository list with what GitHub reports. Mappings of
 * repositories that are still there are kept; removed repositories are deleted.
 */
export async function syncGithubRepositories(
  tenantId: TenantId,
  installationId: number,
  repos: readonly GithubRepoInput[]
): Promise<void> {
  await tx(async (client) => {
    const [owned] = await rows(
      client,
      `select 1 from github_installations where tenant_id = $1 and installation_id = $2 for update`,
      [tenantId, installationId]
    );
    if (!owned) throw new GithubConnectionError('GitHub installation not found.');
    await syncRepos(client, tenantId, installationId, repos);
  });
}

async function syncRepos(
  client: PoolClient,
  tenantId: TenantId,
  installationId: number,
  repos: readonly GithubRepoInput[]
) {
  const list = repos.slice(0, 1000);
  // A repository moves between installations only within one workspace; one that is
  // registered to another workspace's installation is left alone.
  await client.query(
    `insert into github_repositories (tenant_id, installation_id, repo_id, full_name, default_branch)
     select $1, $2, r.repo_id, r.full_name, r.default_branch
     from unnest($3::bigint[], $4::text[], $5::text[]) as r(repo_id, full_name, default_branch)
     on conflict (repo_id) do update set
       installation_id = excluded.installation_id,
       full_name = excluded.full_name,
       default_branch = excluded.default_branch,
       updated_at = now()
     where github_repositories.tenant_id = excluded.tenant_id`,
    [
      tenantId,
      installationId,
      list.map((r) => r.repoId),
      list.map((r) => r.fullName.slice(0, 201)),
      list.map((r) => r.defaultBranch.slice(0, 255)),
    ]
  );
  await client.query(
    `delete from github_repositories
     where tenant_id = $1 and installation_id = $2 and not (repo_id = any($3::bigint[]))`,
    [tenantId, installationId, list.map((r) => r.repoId)]
  );
}

export async function listGithubInstallations(
  tenantId: TenantId
): Promise<GithubInstallationRow[]> {
  return query<GithubInstallationRow>(
    `select i.id, i.installation_id::text, i.account_login, i.account_type,
            i.repository_selection, i.suspended_at, u.email as installed_by_email, i.created_at
     from github_installations i
     left join auth.users u on u.id = i.installed_by
     where i.tenant_id = $1
     order by i.created_at`,
    [tenantId]
  );
}

export async function listGithubRepositories(tenantId: TenantId): Promise<GithubRepositoryRow[]> {
  return query<GithubRepositoryRow>(
    `select id, installation_id::text, repo_id::text, full_name, default_branch, project_id
     from github_repositories where tenant_id = $1 order by lower(full_name)`,
    [tenantId]
  );
}

/** Maps a repository to a project of the same workspace, or unmaps it (null). */
export async function setGithubRepoProject(
  tenantId: TenantId,
  actorId: string,
  repositoryId: string,
  projectId: string | null
): Promise<void> {
  if (!UUID.test(repositoryId) || (projectId !== null && !UUID.test(projectId))) {
    throw new GithubConnectionError('No such repository or project.');
  }
  await tx(async (client) => {
    await requireGithubAdmin(client, tenantId, actorId);
    if (projectId) {
      const [project] = await rows(
        client,
        `select 1 from projects where tenant_id = $1 and id = $2`,
        [tenantId, projectId]
      );
      if (!project) throw new GithubConnectionError('No such repository or project.');
    }
    const updated = await client.query(
      `update github_repositories set project_id = $3, updated_at = now()
       where tenant_id = $1 and id = $2`,
      [tenantId, repositoryId, projectId]
    );
    if (!updated.rowCount) throw new GithubConnectionError('No such repository or project.');
  });
}

/**
 * Forgets every installation of the workspace (repositories, PR links and check-run
 * records go with them). The app stays installed on GitHub until someone uninstalls it.
 */
export async function disconnectGithub(tenantId: TenantId, actorId: string): Promise<void> {
  await tx(async (client) => {
    await requireGithubAdmin(client, tenantId, actorId);
    await client.query(`delete from github_installations where tenant_id = $1`, [tenantId]);
  });
}

/** The workspace an installation belongs to. The one cross-tenant read here. */
export async function installationForWebhook(
  installationId: number
): Promise<{ tenant_id: string; suspended: boolean } | null> {
  if (!Number.isSafeInteger(installationId) || installationId <= 0) return null;
  const [row] = await query<{ tenant_id: string; suspended: boolean }>(
    `select tenant_id, suspended_at is not null as suspended
     from github_installations where installation_id = $1`,
    [installationId]
  );
  return row ?? null;
}

/** GitHub said the installation was removed: forget it (it can be connected again). */
export async function removeGithubInstallation(
  tenantId: TenantId,
  installationId: number
): Promise<void> {
  await query(`delete from github_installations where tenant_id = $1 and installation_id = $2`, [
    tenantId,
    installationId,
  ]);
}

export async function setGithubInstallationSuspended(
  tenantId: TenantId,
  installationId: number,
  suspended: boolean
): Promise<void> {
  await query(
    `update github_installations
     set suspended_at = case when $3 then coalesce(suspended_at, now()) else null end,
         updated_at = now()
     where tenant_id = $1 and installation_id = $2`,
    [tenantId, installationId, suspended]
  );
}

/** A repository of this installation and workspace, by GitHub's repository id. */
export async function repositoryForWebhook(
  tenantId: TenantId,
  installationId: number,
  repoId: number
): Promise<GithubRepositoryRow | null> {
  const [row] = await query<GithubRepositoryRow>(
    `select id, installation_id::text, repo_id::text, full_name, default_branch, project_id
     from github_repositories
     where tenant_id = $1 and installation_id = $2 and repo_id = $3`,
    [tenantId, installationId, repoId]
  );
  return row ?? null;
}

export async function getGithubRepository(
  tenantId: TenantId,
  repositoryId: string
): Promise<GithubRepositoryRow | null> {
  if (!UUID.test(repositoryId)) return null;
  const [row] = await query<GithubRepositoryRow>(
    `select id, installation_id::text, repo_id::text, full_name, default_branch, project_id
     from github_repositories where tenant_id = $1 and id = $2`,
    [tenantId, repositoryId]
  );
  return row ?? null;
}

/**
 * Records a delivery by its X-GitHub-Delivery id. False when it was already recorded:
 * a redelivery of something already accepted.
 */
export async function recordGithubDelivery(
  tenantId: TenantId,
  input: { deliveryId: string; event: string; action: string | null }
): Promise<boolean> {
  const inserted = await query(
    `insert into github_webhook_deliveries (tenant_id, delivery_id, event, action)
     values ($1, $2, $3, $4)
     on conflict do nothing
     returning 1`,
    [
      tenantId,
      input.deliveryId.slice(0, 64),
      input.event.slice(0, 40),
      input.action?.slice(0, 40) ?? null,
    ]
  );
  return inserted.length > 0;
}

/** Drops delivery ids older than anyone would redeliver. */
export async function pruneGithubDeliveries(olderThanDays = 7): Promise<void> {
  await query(
    `delete from github_webhook_deliveries where received_at < now() - make_interval(days => $1)`,
    [olderThanDays]
  );
}

// ---------------------------------------------------------------------------
// Installation tokens
// ---------------------------------------------------------------------------

/** Mint a new token this long before the cached one expires (GitHub's last 1 hour). */
const TOKEN_SKEW_MS = 5 * 60_000;

const tokenContext = (tenantId: TenantId, installationId: number) =>
  `github:${tenantId}:${installationId}:installation-token`;

/**
 * A usable installation access token: the cached one, or one minted by `mint` while the
 * installation row is locked (so concurrent callers mint once). Throws when the
 * installation is not this workspace's or is suspended.
 */
export async function getGithubInstallationToken(
  tenantId: TenantId,
  installationId: number,
  mint: () => Promise<{ token: string; expiresAt: Date }>
): Promise<string> {
  const cached = await readCachedToken(getPool(), tenantId, installationId);
  if (cached) return cached;

  return tx(async (client) => {
    const [installation] = await rows<{ suspended: boolean }>(
      client,
      `select suspended_at is not null as suspended from github_installations
       where tenant_id = $1 and installation_id = $2 for update`,
      [tenantId, installationId]
    );
    if (!installation) throw new GithubConnectionError('GitHub is not connected.');
    if (installation.suspended) {
      throw new GithubConnectionError('The GitHub App installation is suspended.');
    }
    const again = await readCachedToken(client, tenantId, installationId);
    if (again) return again;

    const next = await mint();
    await client.query(
      `insert into github_installation_tokens (tenant_id, installation_id, token_enc, key_id, expires_at)
       values ($1, $2, $3, $4, $5)
       on conflict (installation_id) do update set
         token_enc = excluded.token_enc, key_id = excluded.key_id,
         expires_at = excluded.expires_at, updated_at = now()`,
      [
        tenantId,
        installationId,
        encryptSecret(next.token, tokenContext(tenantId, installationId)),
        tokenKeyId(),
        next.expiresAt,
      ]
    );
    return next.token;
  });
}

async function readCachedToken(
  db: Db,
  tenantId: TenantId,
  installationId: number
): Promise<string | null> {
  const [row] = await rows<{ token_enc: Buffer; key_id: string; expires_at: Date }>(
    db,
    `select t.token_enc, t.key_id, t.expires_at
     from github_installation_tokens t
     join github_installations i on i.installation_id = t.installation_id and i.tenant_id = t.tenant_id
     where t.tenant_id = $1 and t.installation_id = $2 and i.suspended_at is null`,
    [tenantId, installationId]
  );
  if (!row || row.expires_at.getTime() - Date.now() < TOKEN_SKEW_MS) return null;
  // A key change makes the cached token undecryptable: mint a new one instead of failing.
  if (row.key_id !== tokenKeyId()) return null;
  return decryptSecret(row.token_enc, tokenContext(tenantId, installationId), row.key_id);
}

/** Drops the cached token, e.g. after GitHub refused it. */
export async function forgetGithubInstallationToken(
  tenantId: TenantId,
  installationId: number
): Promise<void> {
  await query(
    `delete from github_installation_tokens where tenant_id = $1 and installation_id = $2`,
    [tenantId, installationId]
  );
}

// ---------------------------------------------------------------------------
// Pull requests and their tickets
// ---------------------------------------------------------------------------

export interface PullRequestInput {
  number: number;
  title: string;
  headRef: string;
  headSha: string;
  baseRef: string;
  state: 'open' | 'closed' | 'merged';
  htmlUrl: string | null;
}

export interface PullRequestRow {
  id: string;
  repository_id: string;
  number: number;
  title: string;
  head_ref: string;
  head_sha: string;
  base_ref: string;
  state: 'open' | 'closed' | 'merged';
  html_url: string | null;
  warning_comment_id: string | null;
}

const PR_COLUMNS = `id, repository_id, number, title, head_ref, head_sha, base_ref, state, html_url,
                    warning_comment_id::text`;

async function upsertPull(
  db: Db,
  tenantId: TenantId,
  repositoryId: string,
  pull: PullRequestInput
): Promise<PullRequestRow> {
  const [row] = await rows<PullRequestRow>(
    db,
    `insert into github_pull_requests
       (tenant_id, repository_id, number, title, head_ref, head_sha, base_ref, state, html_url)
     select $1, r.id, $3, $4, $5, $6, $7, $8, $9
     from github_repositories r where r.tenant_id = $1 and r.id = $2
     on conflict (tenant_id, repository_id, number) do update set
       title = excluded.title, head_ref = excluded.head_ref, head_sha = excluded.head_sha,
       base_ref = excluded.base_ref, state = excluded.state, html_url = excluded.html_url,
       updated_at = now()
     returning ${PR_COLUMNS}`,
    [
      tenantId,
      repositoryId,
      pull.number,
      pull.title.slice(0, 1000),
      pull.headRef.slice(0, 255),
      pull.headSha.slice(0, 64),
      pull.baseRef.slice(0, 255),
      pull.state,
      pull.htmlUrl,
    ]
  );
  if (!row) throw new GithubConnectionError('GitHub repository not found.');
  return row;
}

/**
 * Stores a pull request as GitHub reports it, replaces its key-based ticket links, and
 * attaches CI runs already recorded for its head commit. Keys are matched only against
 * tickets of the repository's project (or the whole workspace while it is unmapped).
 */
export async function savePullRequest(
  tenantId: TenantId,
  repositoryId: string,
  pull: PullRequestInput,
  keys: ReadonlyArray<{ key: string; source: 'branch' | 'title' | 'body' }>
): Promise<{ pull: PullRequestRow; linkedTicketIds: string[] }> {
  return tx(async (client) => {
    const saved = await upsertPull(client, tenantId, repositoryId, pull);
    await client.query(
      `delete from github_pr_tickets
       where tenant_id = $1 and pull_request_id = $2 and source <> 'specfix'`,
      [tenantId, saved.id]
    );
    if (keys.length > 0) {
      await client.query(
        `insert into github_pr_tickets (tenant_id, pull_request_id, ticket_id, source)
         select distinct on (t.id) $1, $2, t.id, k.source
         from unnest($3::text[], $4::text[]) with ordinality as k(key, source, ord)
         join tickets t on t.tenant_id = $1 and t.external_key = k.key
         join github_repositories r on r.tenant_id = $1 and r.id = $5
         where r.project_id is null or t.project_id = r.project_id
         order by t.id, k.ord
         on conflict (pull_request_id, ticket_id) do nothing`,
        [tenantId, saved.id, keys.map((k) => k.key), keys.map((k) => k.source), repositoryId]
      );
    }
    await client.query(
      `update ci_runs set pull_request_id = $2, on_default_branch = false
       where tenant_id = $1 and repository_id = $3 and commit_sha = $4
         and pull_request_id is null and not on_default_branch`,
      [tenantId, saved.id, repositoryId, saved.head_sha]
    );
    const linked = await rows<{ ticket_id: string }>(
      client,
      `select ticket_id from github_pr_tickets where tenant_id = $1 and pull_request_id = $2`,
      [tenantId, saved.id]
    );
    return { pull: saved, linkedTicketIds: linked.map((l) => l.ticket_id) };
  });
}

export async function getPullRequest(
  tenantId: TenantId,
  pullRequestId: string
): Promise<PullRequestRow | null> {
  if (!UUID.test(pullRequestId)) return null;
  const [row] = await query<PullRequestRow>(
    `select ${PR_COLUMNS} from github_pull_requests where tenant_id = $1 and id = $2`,
    [tenantId, pullRequestId]
  );
  return row ?? null;
}

export interface PullRequestTicketRow {
  ticket_id: string;
  external_key: string;
  /** The ticket's latest version is marked ready for development. */
  ready: boolean;
}

export async function pullRequestTickets(
  tenantId: TenantId,
  pullRequestId: string
): Promise<PullRequestTicketRow[]> {
  return query<PullRequestTicketRow>(
    `select t.id as ticket_id, t.external_key,
            exists (
              select 1 from readiness_events e
              where e.tenant_id = t.tenant_id and e.ticket_id = t.id and e.event = 'marked_ready'
                and e.ticket_version_id = (
                  select v.id from ticket_versions v
                  where v.tenant_id = t.tenant_id and v.ticket_id = t.id
                  order by v.captured_at desc limit 1)
            ) as ready
     from github_pr_tickets l
     join tickets t on t.id = l.ticket_id and t.tenant_id = l.tenant_id
     where l.tenant_id = $1 and l.pull_request_id = $2
     order by t.external_key`,
    [tenantId, pullRequestId]
  );
}

/**
 * Runs `post` with the PR row locked and stores the comment id it returns, so two jobs
 * for the same PR never both post the "not ready" comment. `post` receives the current
 * comment id (null when there is none yet) and returns the id to keep.
 */
export async function withWarningComment(
  tenantId: TenantId,
  pullRequestId: string,
  post: (commentId: number | null) => Promise<number | null>
): Promise<void> {
  await tx(async (client) => {
    const [row] = await rows<{ warning_comment_id: string | null }>(
      client,
      `select warning_comment_id::text from github_pull_requests
       where tenant_id = $1 and id = $2 for update`,
      [tenantId, pullRequestId]
    );
    if (!row) throw new GithubConnectionError('Pull request not found.');
    const next = await post(
      row.warning_comment_id === null ? null : Number(row.warning_comment_id)
    );
    await client.query(
      `update github_pull_requests set warning_comment_id = $3 where tenant_id = $1 and id = $2`,
      [tenantId, pullRequestId, next]
    );
  });
}

/** Queues a re-check of every open PR linked to the ticket (e.g. it was just marked ready). */
export async function queueGithubSyncForTicket(
  tenantId: TenantId,
  ticketId: string
): Promise<number> {
  const prs = await query<{ repository_id: string; number: number }>(
    `select p.repository_id, p.number
     from github_pr_tickets l
     join github_pull_requests p on p.id = l.pull_request_id and p.tenant_id = l.tenant_id
     where l.tenant_id = $1 and l.ticket_id = $2 and p.state = 'open'`,
    [tenantId, ticketId]
  );
  let queued = 0;
  for (const pr of prs) {
    const job = await enqueueJob(tenantId, {
      kind: 'github_pr_sync',
      payload: { repositoryId: pr.repository_id, number: pr.number },
      dedupeKey: `gh-pr:${pr.repository_id}:${pr.number}`,
      maxAttempts: 4,
    });
    if (job) queued += 1;
  }
  return queued;
}

export interface TicketPullRequestRow {
  id: string;
  full_name: string;
  number: number;
  title: string;
  head_ref: string;
  head_sha: string;
  state: 'open' | 'closed' | 'merged';
  html_url: string | null;
  source: 'branch' | 'title' | 'body' | 'specfix';
  check_conclusion: 'success' | 'failure' | 'neutral' | null;
  check_title: string | null;
  run_passed: number | null;
  run_total: number | null;
  run_failed: number | null;
  run_commit: string | null;
  run_received_at: Date | null;
}

/**
 * The PRs linked to a ticket, each with its latest CI run and the check run on its head
 * commit. PR runs are shown here, per PR; they never set the ticket's own CI status.
 */
export async function pullRequestsForTicket(
  tenantId: TenantId,
  ticketId: string
): Promise<TicketPullRequestRow[]> {
  return query<TicketPullRequestRow>(
    `select p.id, r.full_name, p.number, p.title, p.head_ref, p.head_sha, p.state, p.html_url,
            l.source, c.conclusion as check_conclusion, c.title as check_title,
            run.passed as run_passed, run.total as run_total, run.failed as run_failed,
            run.commit_sha as run_commit, run.received_at as run_received_at
     from github_pr_tickets l
     join github_pull_requests p on p.id = l.pull_request_id and p.tenant_id = l.tenant_id
     join github_repositories r on r.id = p.repository_id and r.tenant_id = p.tenant_id
     left join github_check_runs c
       on c.tenant_id = p.tenant_id and c.pull_request_id = p.id and c.head_sha = p.head_sha
     left join lateral (
       select cr.passed + cr.flaky as passed, cr.total, cr.failed, cr.commit_sha, cr.received_at
       from ci_runs cr
       where cr.tenant_id = p.tenant_id and cr.pull_request_id = p.id
       order by cr.received_at desc limit 1
     ) run on true
     where l.tenant_id = $1 and l.ticket_id = $2
     order by (p.state = 'open') desc, p.updated_at desc`,
    [tenantId, ticketId]
  );
}

// ---------------------------------------------------------------------------
// Check runs
// ---------------------------------------------------------------------------

export interface PullRequestAcceptance {
  pull: PullRequestRow;
  repo: GithubRepositoryRow;
  ciRunId: string | null;
  runUrl: string | null;
  tickets: Array<{
    ticket_id: string;
    external_key: string;
    scenarios: Array<{
      scenario_id: string;
      status: 'passed' | 'failed' | 'flaky' | 'skipped' | null;
    }>;
  }>;
}

/**
 * What the "SpecFix acceptance" check needs for a PR's head commit: the newest CI run
 * for that commit, and for each linked ticket the approved scenarios of its latest
 * version with their result in that run (null when the run did not report it).
 */
export async function acceptanceForPullRequest(
  tenantId: TenantId,
  pullRequestId: string
): Promise<PullRequestAcceptance | null> {
  const pull = await getPullRequest(tenantId, pullRequestId);
  if (!pull) return null;
  const repo = await getGithubRepository(tenantId, pull.repository_id);
  if (!repo) return null;
  const [run] = await query<{ id: string; run_url: string | null }>(
    `select id, run_url from ci_runs
     where tenant_id = $1 and pull_request_id = $2 and commit_sha = $3
     order by received_at desc limit 1`,
    [tenantId, pull.id, pull.head_sha]
  );
  const scenarioRows = await query<{
    ticket_id: string;
    external_key: string;
    scenario_id: string | null;
    status: 'passed' | 'failed' | 'flaky' | 'skipped' | null;
  }>(
    `select t.id as ticket_id, t.external_key, s.id as scenario_id, res.status
     from github_pr_tickets l
     join tickets t on t.id = l.ticket_id and t.tenant_id = l.tenant_id
     left join lateral (
       select v.id from ticket_versions v
       where v.tenant_id = t.tenant_id and v.ticket_id = t.id
       order by v.captured_at desc limit 1
     ) v on true
     left join scenarios s
       on s.tenant_id = t.tenant_id and s.ticket_version_id = v.id
      and s.status in ('approved', 'edited')
     left join ci_results res
       on res.tenant_id = t.tenant_id and res.ci_run_id = $3 and res.scenario_id = s.id
     where l.tenant_id = $1 and l.pull_request_id = $2
     order by t.external_key, s.created_at`,
    [tenantId, pull.id, run?.id ?? null]
  );
  const tickets = new Map<string, PullRequestAcceptance['tickets'][number]>();
  for (const r of scenarioRows) {
    const entry = tickets.get(r.ticket_id) ?? {
      ticket_id: r.ticket_id,
      external_key: r.external_key,
      scenarios: [],
    };
    if (r.scenario_id) entry.scenarios.push({ scenario_id: r.scenario_id, status: r.status });
    tickets.set(r.ticket_id, entry);
  }
  return {
    pull,
    repo,
    ciRunId: run?.id ?? null,
    runUrl: run?.run_url ?? null,
    tickets: [...tickets.values()],
  };
}

/**
 * Runs `publish` with the (PR, head commit) check-run record locked, so concurrent jobs
 * create one check run and then only update it. `publish` gets the existing GitHub
 * check-run id (null the first time) and returns the id it created or updated.
 */
export async function withCheckRun(
  tenantId: TenantId,
  pullRequestId: string,
  headSha: string,
  publish: (checkRunId: number | null) => Promise<{
    checkRunId: number;
    conclusion: 'success' | 'failure' | 'neutral';
    title: string;
    ciRunId: string | null;
  }>
): Promise<void> {
  await tx(async (client) => {
    await client.query(
      `insert into github_check_runs (tenant_id, pull_request_id, head_sha)
       select tenant_id, id, $3 from github_pull_requests where tenant_id = $1 and id = $2
       on conflict (pull_request_id, head_sha) do nothing`,
      [tenantId, pullRequestId, headSha.slice(0, 64)]
    );
    const [row] = await rows<{ check_run_id: string | null }>(
      client,
      `select check_run_id::text from github_check_runs
       where tenant_id = $1 and pull_request_id = $2 and head_sha = $3 for update`,
      [tenantId, pullRequestId, headSha.slice(0, 64)]
    );
    if (!row) throw new GithubConnectionError('Pull request not found.');
    const result = await publish(row.check_run_id === null ? null : Number(row.check_run_id));
    await client.query(
      `update github_check_runs
       set check_run_id = $4, conclusion = $5, title = $6, ci_run_id = $7, updated_at = now()
       where tenant_id = $1 and pull_request_id = $2 and head_sha = $3`,
      [
        tenantId,
        pullRequestId,
        headSha.slice(0, 64),
        result.checkRunId,
        result.conclusion,
        result.title.slice(0, 200),
        result.ciRunId,
      ]
    );
  });
}

// ---------------------------------------------------------------------------
// "Open PR with scaffolds"
// ---------------------------------------------------------------------------

export interface ScaffoldPrContext {
  ticket: { id: string; external_key: string; project_id: string };
  repos: GithubRepositoryRow[];
  scaffolds: Array<{ id: string; scenario_id: string; code: string }>;
  existing: TicketPullRequestRow | null;
}

/** What the Specs tab needs to offer the button: mapped repos and approved scaffolds. */
export async function scaffoldPrContext(
  tenantId: TenantId,
  ticketId: string
): Promise<ScaffoldPrContext | null> {
  if (!UUID.test(ticketId)) return null;
  const [ticket] = await query<ScaffoldPrContext['ticket']>(
    `select id, external_key, project_id from tickets where tenant_id = $1 and id = $2`,
    [tenantId, ticketId]
  );
  if (!ticket) return null;
  const repos = await query<GithubRepositoryRow>(
    `select r.id, r.installation_id::text, r.repo_id::text, r.full_name, r.default_branch, r.project_id
     from github_repositories r
     join github_installations i on i.installation_id = r.installation_id and i.tenant_id = r.tenant_id
     where r.tenant_id = $1 and r.project_id = $2 and i.suspended_at is null
     order by lower(r.full_name)`,
    [tenantId, ticket.project_id]
  );
  const scaffolds = await query<ScaffoldPrContext['scaffolds'][number]>(
    `select sc.id, sc.scenario_id, sc.code
     from test_scaffolds sc
     where sc.tenant_id = $1 and sc.ticket_id = $2 and sc.status in ('approved', 'edited')
       and sc.ticket_version_id = (
         select v.id from ticket_versions v where v.tenant_id = $1 and v.ticket_id = $2
         order by v.captured_at desc limit 1)
     order by sc.created_at`,
    [tenantId, ticketId]
  );
  const existing =
    (await pullRequestsForTicket(tenantId, ticketId)).find(
      (p) => p.source === 'specfix' && p.state === 'open'
    ) ?? null;
  return { ticket, repos, scaffolds, existing };
}

/**
 * Opens (or reuses) the scaffold PR for a ticket in one repository. Owner/admin only.
 *
 * The claim row is locked for the whole operation, so a double click or two admins at
 * once produce one branch and one PR: the second caller waits, then finds the PR the
 * first one opened. `open` does the GitHub work and is only called when there is no
 * open SpecFix PR for this ticket and repository yet.
 */
export async function openScaffoldPullRequest(
  tenantId: TenantId,
  actorId: string,
  input: { ticketId: string; repositoryId: string; branch: string },
  open: (repo: GithubRepositoryRow) => Promise<PullRequestInput>
): Promise<{ pull: PullRequestRow; reused: boolean }> {
  if (!UUID.test(input.ticketId) || !UUID.test(input.repositoryId)) {
    throw new GithubConnectionError('No such ticket or repository.');
  }
  return tx(async (client) => {
    await requireGithubAdmin(client, tenantId, actorId);
    const [repo] = await rows<GithubRepositoryRow>(
      client,
      `select r.id, r.installation_id::text, r.repo_id::text, r.full_name, r.default_branch, r.project_id
       from github_repositories r
       join tickets t on t.tenant_id = r.tenant_id and t.project_id = r.project_id
       where r.tenant_id = $1 and r.id = $2 and t.id = $3`,
      [tenantId, input.repositoryId, input.ticketId]
    );
    if (!repo)
      throw new GithubConnectionError('That repository is not mapped to this ticket’s project.');

    await client.query(
      `insert into github_scaffold_prs (tenant_id, ticket_id, repository_id, branch, opened_by)
       values ($1, $2, $3, $4, $5)
       on conflict (tenant_id, ticket_id, repository_id) do nothing`,
      [tenantId, input.ticketId, repo.id, input.branch, actorId]
    );
    const [claim] = await rows<{ pull_request_id: string | null }>(
      client,
      `select pull_request_id from github_scaffold_prs
       where tenant_id = $1 and ticket_id = $2 and repository_id = $3 for update`,
      [tenantId, input.ticketId, repo.id]
    );
    if (claim?.pull_request_id) {
      const [current] = await rows<PullRequestRow>(
        client,
        `select ${PR_COLUMNS} from github_pull_requests where tenant_id = $1 and id = $2`,
        [tenantId, claim.pull_request_id]
      );
      if (current?.state === 'open') return { pull: current, reused: true };
    }

    const pull = await upsertPull(client, tenantId, repo.id, await open(repo));
    await client.query(
      `insert into github_pr_tickets (tenant_id, pull_request_id, ticket_id, source)
       values ($1, $2, $3, 'specfix')
       on conflict (pull_request_id, ticket_id) do update set source = 'specfix'`,
      [tenantId, pull.id, input.ticketId]
    );
    await client.query(
      `update github_scaffold_prs set pull_request_id = $4, branch = $5, updated_at = now()
       where tenant_id = $1 and ticket_id = $2 and repository_id = $3`,
      [tenantId, input.ticketId, repo.id, pull.id, input.branch]
    );
    return { pull, reused: false };
  });
}
