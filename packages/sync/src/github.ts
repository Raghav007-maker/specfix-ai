/**
 * The GitHub side of the loop, run by the worker (and, for "Open PR with scaffolds", by
 * the web app's server action):
 *
 *   github_pr_sync     re-read a PR, link it to tickets by the Jira keys in its branch,
 *                      title or body, keep its one "not ready" comment current, and
 *                      publish the acceptance check if CI already reported on its head.
 *   github_check_run   publish the "SpecFix acceptance" check run for a PR's head commit.
 *   github_repo_sync   refresh the repositories an installation can reach.
 *
 * Token caching and every row lock are @specfix/db's; HTTP is @specfix/ingest's. This
 * module never touches Jira: GitHub writes only.
 */
import {
  GithubAuthError,
  GithubClient,
  createInstallationToken,
  githubAppConfigFromEnv,
  jiraKeysInPullRequest,
  notReadyComment,
  safeRefSegment,
  summarizeAcceptance,
  type GithubAppConfig,
} from '@specfix/ingest';
import {
  GithubConnectionError,
  acceptanceForPullRequest,
  forgetGithubInstallationToken,
  getGithubInstallationToken,
  getGithubRepository,
  openScaffoldPullRequest,
  pullRequestTickets,
  savePullRequest,
  scaffoldPrContext,
  syncGithubRepositories,
  withCheckRun,
  withWarningComment,
  type JobRow,
  type PullRequestRow,
} from '@specfix/db';
import { PermanentJobError } from './errors.ts';
import { publicBaseUrlFromEnv } from './live.ts';

export const CHECK_RUN_NAME = 'SpecFix acceptance';

export interface GithubDeps {
  config?: GithubAppConfig | null;
  fetchImpl?: typeof fetch;
  publicBaseUrl?: string | null;
}

/** An API client for one installation, with its token from the encrypted cache. */
export async function githubClientFor(
  tenantId: string,
  installationId: number,
  deps: GithubDeps = {}
): Promise<GithubClient> {
  const config = deps.config === undefined ? githubAppConfigFromEnv() : deps.config;
  if (!config) throw new PermanentJobError('The GitHub App is not configured on this server.');
  const fetchImpl = deps.fetchImpl ?? fetch;
  try {
    const token = await getGithubInstallationToken(tenantId, installationId, () =>
      createInstallationToken(config, installationId, fetchImpl)
    );
    return new GithubClient(token, fetchImpl);
  } catch (error) {
    // No token can be minted: the app was uninstalled or suspended. Retrying cannot help.
    if (error instanceof GithubAuthError || error instanceof GithubConnectionError) {
      throw new PermanentJobError(error.message);
    }
    throw error;
  }
}

/**
 * Runs `work`; if GitHub refused the cached token, drops it so the retry mints a new one.
 */
async function withToken<T>(
  tenantId: string,
  installationId: number,
  work: () => Promise<T>
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof GithubAuthError) {
      await forgetGithubInstallationToken(tenantId, installationId);
      throw new Error(error.message);
    }
    throw error;
  }
}

const baseUrl = (deps: GithubDeps) =>
  deps.publicBaseUrl === undefined ? publicBaseUrlFromEnv() : deps.publicBaseUrl;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function runGithubPrSync(job: JobRow, deps: GithubDeps = {}): Promise<object> {
  const repositoryId = String(job.payload.repositoryId ?? '');
  const number = Number(job.payload.number);
  if (!UUID.test(repositoryId) || !Number.isSafeInteger(number) || number <= 0) {
    throw new PermanentJobError('Malformed github_pr_sync payload.');
  }
  const repo = await getGithubRepository(job.tenant_id, repositoryId);
  if (!repo) return { skipped: 'repository no longer connected' };
  const installationId = Number(repo.installation_id);
  const client = await githubClientFor(job.tenant_id, installationId, deps);

  return withToken(job.tenant_id, installationId, async () => {
    const pull = await client.getPullRequest(repo.full_name, number);
    const keys = jiraKeysInPullRequest({
      branch: pull.headRef,
      title: pull.title,
      body: pull.body,
    });
    const { pull: saved } = await savePullRequest(job.tenant_id, repo.id, pull, keys);
    const tickets = await pullRequestTickets(job.tenant_id, saved.id);
    const notReady = tickets.filter((t) => !t.ready);
    const base = baseUrl(deps);

    await withWarningComment(job.tenant_id, saved.id, async (commentId) => {
      if (saved.state !== 'open' || tickets.length === 0) return commentId;
      if (notReady.length === 0 && commentId === null) return null;
      const body = notReadyComment({
        notReady: notReady.map((t) => ({
          key: t.external_key,
          url: base ? `${base}/tickets/${t.ticket_id}` : null,
        })),
        ready: tickets.filter((t) => t.ready).map((t) => t.external_key),
      });
      if (
        commentId !== null &&
        (await client.updateIssueComment(repo.full_name, commentId, body))
      ) {
        return commentId;
      }
      // The comment was deleted on GitHub: post it again only while there is a warning.
      if (notReady.length === 0) return null;
      return client.createIssueComment(repo.full_name, saved.number, body);
    });

    const check =
      tickets.length > 0 ? await publishCheck(job.tenant_id, saved, client, deps) : null;
    return { pull: saved.number, linked: tickets.length, notReady: notReady.length, check };
  });
}

export async function runGithubCheckRun(job: JobRow, deps: GithubDeps = {}): Promise<object> {
  const pullRequestId = String(job.payload.pullRequestId ?? '');
  if (!UUID.test(pullRequestId)) throw new PermanentJobError('Malformed github_check_run payload.');
  const acceptance = await acceptanceForPullRequest(job.tenant_id, pullRequestId);
  if (!acceptance) return { skipped: 'pull request no longer connected' };
  if (acceptance.tickets.length === 0) return { skipped: 'no linked tickets' };
  const installationId = Number(acceptance.repo.installation_id);
  const client = await githubClientFor(job.tenant_id, installationId, deps);
  return withToken(job.tenant_id, installationId, async () => ({
    check: await publishCheck(job.tenant_id, acceptance.pull, client, deps),
  }));
}

/** Creates or updates the check run on the PR's head commit. Null when CI has not reported. */
async function publishCheck(
  tenantId: string,
  pull: PullRequestRow,
  client: GithubClient,
  deps: GithubDeps
): Promise<string | null> {
  const acceptance = await acceptanceForPullRequest(tenantId, pull.id);
  if (!acceptance?.ciRunId || acceptance.tickets.length === 0) return null;
  const base = baseUrl(deps);
  const first = acceptance.tickets[0]!;
  const detailsUrl = base ? `${base}/tickets/${first.ticket_id}/specs` : null;
  const verdict = summarizeAcceptance({
    tickets: acceptance.tickets.map((t) => ({
      key: t.external_key,
      scenarios: t.scenarios.map((s) => ({ status: s.status })),
    })),
    detailsUrl,
  });
  const fullName = acceptance.repo.full_name;
  const headSha = acceptance.pull.head_sha;
  await withCheckRun(tenantId, pull.id, headSha, async (checkRunId) => {
    const output = {
      conclusion: verdict.conclusion,
      title: verdict.title,
      summary: verdict.summary,
      detailsUrl,
    };
    let id = checkRunId;
    if (id === null) {
      id = await client.createCheckRun(fullName, { name: CHECK_RUN_NAME, headSha, ...output });
    } else {
      await client.updateCheckRun(fullName, id, output);
    }
    return {
      checkRunId: id,
      conclusion: verdict.conclusion,
      title: verdict.title,
      ciRunId: acceptance.ciRunId,
    };
  });
  return `${verdict.conclusion}: ${verdict.title}`;
}

export async function runGithubRepoSync(job: JobRow, deps: GithubDeps = {}): Promise<object> {
  const installationId = Number(job.payload.installationId);
  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    throw new PermanentJobError('Malformed github_repo_sync payload.');
  }
  const client = await githubClientFor(job.tenant_id, installationId, deps);
  return withToken(job.tenant_id, installationId, async () => {
    const repos = await client.listInstallationRepos();
    await syncGithubRepositories(job.tenant_id, installationId, repos);
    return { repositories: repos.length };
  });
}

/**
 * "Open PR with scaffolds": commits the ticket's approved scaffolds to `specfix/<KEY>`
 * (one commit on top of the default branch, or on top of the branch if it already
 * exists) and opens a PR into the default branch — or returns the one already open.
 * Owner/admin only (checked again by @specfix/db inside the claim).
 */
export async function openScaffoldPr(
  tenantId: string,
  actorId: string,
  input: { ticketId: string; repositoryId?: string | null },
  deps: GithubDeps = {}
): Promise<{ number: number; url: string | null; reused: boolean }> {
  const ctx = await scaffoldPrContext(tenantId, input.ticketId);
  if (!ctx) throw new GithubConnectionError('Ticket not found.');
  if (ctx.scaffolds.length === 0) {
    throw new GithubConnectionError('Approve at least one scaffold before opening a PR.');
  }
  const repo = input.repositoryId
    ? ctx.repos.find((r) => r.id === input.repositoryId)
    : ctx.repos.length === 1
      ? ctx.repos[0]
      : undefined;
  if (!repo) {
    throw new GithubConnectionError(
      ctx.repos.length === 0
        ? 'Map a GitHub repository to this project in Settings → Integrations first.'
        : 'Choose which repository to open the PR in.'
    );
  }

  const segment = safeRefSegment(ctx.ticket.external_key);
  const branch = `specfix/${segment}`;
  const base = baseUrl(deps);
  const installationId = Number(repo.installation_id);

  const { pull, reused } = await openScaffoldPullRequest(
    tenantId,
    actorId,
    { ticketId: ctx.ticket.id, repositoryId: repo.id, branch },
    async (locked) => {
      const client = await githubClientFor(tenantId, installationId, deps);
      return withToken(tenantId, installationId, async () => {
        const fullName = locked.full_name;
        const owner = fullName.split('/')[0]!;
        const baseSha = await client.getBranchSha(fullName, locked.default_branch);
        if (!baseSha)
          throw new GithubConnectionError('The repository’s default branch was not found.');
        const headSha = await client.getBranchSha(fullName, branch);
        const parent = headSha ?? baseSha;
        const parentTree = await client.getCommitTree(fullName, parent);
        const tree = await client.createTree(
          fullName,
          parentTree,
          ctx.scaffolds.map((s) => ({
            path: `tests/specfix/${segment}/${s.scenario_id}.spec.ts`,
            content: s.code.endsWith('\n') ? s.code : `${s.code}\n`,
          }))
        );
        let tip = parent;
        if (tree !== parentTree) {
          tip = await client.createCommit(fullName, {
            message: `SpecFix: acceptance test scaffolds for ${segment}`,
            tree,
            parent,
          });
        }
        if (headSha === null) await client.createBranch(fullName, branch, tip);
        else if (tip !== headSha) await client.updateBranch(fullName, branch, tip);

        const open =
          (await client.findOpenPull(fullName, owner, branch)) ??
          (await client.createPullRequest(fullName, {
            title: `${segment}: acceptance test scaffolds from SpecFix`,
            head: branch,
            base: locked.default_branch,
            body: [
              `Playwright scaffolds for the ${ctx.scaffolds.length} approved acceptance scenario${ctx.scaffolds.length === 1 ? '' : 's'} of ${segment}.`,
              '',
              'Each test carries its `@sf-<scenario id>` tag, so CI results flow back to SpecFix once your pipeline posts the Playwright JSON report.',
              base ? `\nTicket in SpecFix: ${base}/tickets/${ctx.ticket.id}/specs` : '',
            ].join('\n'),
          }));
        return {
          number: open.number,
          title: open.title,
          headRef: open.headRef,
          headSha: open.headSha,
          baseRef: open.baseRef,
          state: open.state,
          htmlUrl: open.htmlUrl,
        };
      });
    }
  );
  return { number: pull.number, url: pull.html_url, reused };
}
