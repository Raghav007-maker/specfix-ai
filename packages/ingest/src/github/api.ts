/**
 * The GitHub REST calls SpecFix makes with an installation token: listing repositories,
 * reading pull requests, check runs, PR comments, and the Git data calls that commit
 * scaffolds to a branch and open a PR.
 *
 * Repository names and branch names go into URL paths, so both are validated (and each
 * path segment encoded) before any request is built. Responses are read defensively:
 * only the fields used are taken, with their types checked.
 */
import { GITHUB_API, GITHUB_HEADERS, GithubAuthError, GithubHttpError } from './app.ts';

const FULL_NAME = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

export function isRepoFullName(value: string): boolean {
  return FULL_NAME.test(value) && !value.split('/').some((p) => p === '.' || p === '..');
}

/** A branch name GitHub would accept, conservatively: no `..`, no control characters. */
export function isSafeBranchName(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 200 &&
    /^[A-Za-z0-9._/-]+$/.test(value) &&
    !value.includes('..') &&
    !value.includes('//') &&
    !value.startsWith('/') &&
    !value.endsWith('/') &&
    !value.endsWith('.lock')
  );
}

const refPath = (branch: string) => branch.split('/').map(encodeURIComponent).join('/');

export interface GithubRepo {
  repoId: number;
  fullName: string;
  defaultBranch: string;
}

export interface GithubPull {
  number: number;
  title: string;
  body: string | null;
  headRef: string;
  headSha: string;
  baseRef: string;
  state: 'open' | 'closed' | 'merged';
  htmlUrl: string | null;
}

export class GithubClient {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  private async call(
    what: string,
    method: string,
    path: string,
    body?: unknown,
    okStatuses: number[] = []
  ): Promise<{ status: number; json: unknown }> {
    const response = await this.fetchImpl(`${GITHUB_API}${path}`, {
      method,
      headers: {
        ...GITHUB_HEADERS,
        Authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.ok || okStatuses.includes(response.status)) {
      const json = response.status === 204 ? null : await response.json().catch(() => null);
      return { status: response.status, json };
    }
    if (response.status === 401) {
      throw new GithubAuthError(`GitHub refused the installation token (${what}).`);
    }
    throw new GithubHttpError(`GitHub ${what} failed (HTTP ${response.status}).`, response.status);
  }

  private repo(fullName: string): string {
    if (!isRepoFullName(fullName)) throw new GithubHttpError('Invalid repository name.', 400);
    return `/repos/${fullName}`;
  }

  /** Every repository the installation can reach (stops at 1,000). */
  async listInstallationRepos(): Promise<GithubRepo[]> {
    const repos: GithubRepo[] = [];
    for (let page = 1; page <= 10; page++) {
      const { json } = await this.call(
        'listing repositories',
        'GET',
        `/installation/repositories?per_page=100&page=${page}`
      );
      const list = (json as { repositories?: unknown[] } | null)?.repositories;
      if (!Array.isArray(list)) break;
      for (const r of list as Array<Record<string, unknown>>) {
        if (
          typeof r.id === 'number' &&
          typeof r.full_name === 'string' &&
          isRepoFullName(r.full_name) &&
          typeof r.default_branch === 'string'
        ) {
          repos.push({
            repoId: r.id,
            fullName: r.full_name,
            defaultBranch: r.default_branch.slice(0, 255),
          });
        }
      }
      if (list.length < 100) break;
    }
    return repos;
  }

  async getPullRequest(fullName: string, number: number): Promise<GithubPull> {
    const { json } = await this.call(
      'reading a pull request',
      'GET',
      `${this.repo(fullName)}/pulls/${number}`
    );
    const pull = parsePull(json);
    if (!pull) throw new GithubHttpError('GitHub pull request response was incomplete.', 502);
    return pull;
  }

  /** The open PR from `branch` (in the same repository) into any base, if there is one. */
  async findOpenPull(fullName: string, owner: string, branch: string): Promise<GithubPull | null> {
    const head = encodeURIComponent(`${owner}:${branch}`);
    const { json } = await this.call(
      'listing pull requests',
      'GET',
      `${this.repo(fullName)}/pulls?state=open&head=${head}&per_page=5`
    );
    const first = Array.isArray(json) ? json[0] : null;
    return first ? parsePull(first) : null;
  }

  async createPullRequest(
    fullName: string,
    input: { title: string; head: string; base: string; body: string }
  ): Promise<GithubPull> {
    const { json } = await this.call(
      'opening a pull request',
      'POST',
      `${this.repo(fullName)}/pulls`,
      input
    );
    const pull = parsePull(json);
    if (!pull) throw new GithubHttpError('GitHub pull request response was incomplete.', 502);
    return pull;
  }

  async createCheckRun(
    fullName: string,
    input: {
      name: string;
      headSha: string;
      conclusion: string;
      title: string;
      summary: string;
      detailsUrl?: string | null;
    }
  ): Promise<number> {
    const { json } = await this.call(
      'creating a check run',
      'POST',
      `${this.repo(fullName)}/check-runs`,
      {
        name: input.name,
        head_sha: input.headSha,
        status: 'completed',
        conclusion: input.conclusion,
        ...(input.detailsUrl ? { details_url: input.detailsUrl } : {}),
        output: { title: input.title, summary: input.summary },
      }
    );
    const id = (json as { id?: unknown } | null)?.id;
    if (typeof id !== 'number')
      throw new GithubHttpError('GitHub check run response was incomplete.', 502);
    return id;
  }

  async updateCheckRun(
    fullName: string,
    checkRunId: number,
    input: { conclusion: string; title: string; summary: string; detailsUrl?: string | null }
  ): Promise<void> {
    await this.call(
      'updating a check run',
      'PATCH',
      `${this.repo(fullName)}/check-runs/${checkRunId}`,
      {
        status: 'completed',
        conclusion: input.conclusion,
        ...(input.detailsUrl ? { details_url: input.detailsUrl } : {}),
        output: { title: input.title, summary: input.summary },
      }
    );
  }

  async createIssueComment(fullName: string, number: number, body: string): Promise<number> {
    const { json } = await this.call(
      'commenting on a pull request',
      'POST',
      `${this.repo(fullName)}/issues/${number}/comments`,
      { body }
    );
    const id = (json as { id?: unknown } | null)?.id;
    if (typeof id !== 'number')
      throw new GithubHttpError('GitHub comment response was incomplete.', 502);
    return id;
  }

  /** False when the comment no longer exists (deleted on GitHub), so the caller can re-post. */
  async updateIssueComment(fullName: string, commentId: number, body: string): Promise<boolean> {
    const { status } = await this.call(
      'updating a pull request comment',
      'PATCH',
      `${this.repo(fullName)}/issues/comments/${commentId}`,
      { body },
      [404]
    );
    return status !== 404;
  }

  /** The commit a branch points at, or null when the branch does not exist. */
  async getBranchSha(fullName: string, branch: string): Promise<string | null> {
    if (!isSafeBranchName(branch)) throw new GithubHttpError('Invalid branch name.', 400);
    const { status, json } = await this.call(
      'reading a branch',
      'GET',
      `${this.repo(fullName)}/git/ref/heads/${refPath(branch)}`,
      undefined,
      [404]
    );
    if (status === 404) return null;
    const sha = (json as { object?: { sha?: unknown } } | null)?.object?.sha;
    if (typeof sha !== 'string')
      throw new GithubHttpError('GitHub ref response was incomplete.', 502);
    return sha;
  }

  async getCommitTree(fullName: string, commitSha: string): Promise<string> {
    const { json } = await this.call(
      'reading a commit',
      'GET',
      `${this.repo(fullName)}/git/commits/${encodeURIComponent(commitSha)}`
    );
    const tree = (json as { tree?: { sha?: unknown } } | null)?.tree?.sha;
    if (typeof tree !== 'string')
      throw new GithubHttpError('GitHub commit response was incomplete.', 502);
    return tree;
  }

  /** A tree of `files` on top of `baseTree`. Returns the new tree's sha. */
  async createTree(
    fullName: string,
    baseTree: string,
    files: Array<{ path: string; content: string }>
  ): Promise<string> {
    const { json } = await this.call(
      'creating a tree',
      'POST',
      `${this.repo(fullName)}/git/trees`,
      {
        base_tree: baseTree,
        tree: files.map((f) => ({
          path: f.path,
          mode: '100644',
          type: 'blob',
          content: f.content,
        })),
      }
    );
    const sha = (json as { sha?: unknown } | null)?.sha;
    if (typeof sha !== 'string')
      throw new GithubHttpError('GitHub tree response was incomplete.', 502);
    return sha;
  }

  async createCommit(
    fullName: string,
    input: { message: string; tree: string; parent: string }
  ): Promise<string> {
    const { json } = await this.call(
      'creating a commit',
      'POST',
      `${this.repo(fullName)}/git/commits`,
      {
        message: input.message,
        tree: input.tree,
        parents: [input.parent],
      }
    );
    const sha = (json as { sha?: unknown } | null)?.sha;
    if (typeof sha !== 'string')
      throw new GithubHttpError('GitHub commit response was incomplete.', 502);
    return sha;
  }

  async createBranch(fullName: string, branch: string, sha: string): Promise<void> {
    if (!isSafeBranchName(branch)) throw new GithubHttpError('Invalid branch name.', 400);
    await this.call('creating a branch', 'POST', `${this.repo(fullName)}/git/refs`, {
      ref: `refs/heads/${branch}`,
      sha,
    });
  }

  /** Moves a branch forward to `sha`; never forces, so someone else's commits are kept. */
  async updateBranch(fullName: string, branch: string, sha: string): Promise<void> {
    if (!isSafeBranchName(branch)) throw new GithubHttpError('Invalid branch name.', 400);
    await this.call(
      'updating a branch',
      'PATCH',
      `${this.repo(fullName)}/git/refs/heads/${refPath(branch)}`,
      { sha, force: false }
    );
  }
}

function parsePull(json: unknown): GithubPull | null {
  if (typeof json !== 'object' || json === null) return null;
  const p = json as Record<string, unknown>;
  const head = p.head as { ref?: unknown; sha?: unknown } | null;
  const base = p.base as { ref?: unknown } | null;
  if (
    typeof p.number !== 'number' ||
    typeof head?.ref !== 'string' ||
    typeof head.sha !== 'string' ||
    typeof base?.ref !== 'string'
  ) {
    return null;
  }
  const merged = p.merged === true || (typeof p.merged_at === 'string' && p.merged_at !== '');
  const htmlUrl =
    typeof p.html_url === 'string' && p.html_url.startsWith('https://')
      ? p.html_url.slice(0, 500)
      : null;
  return {
    number: p.number,
    title: typeof p.title === 'string' ? p.title.slice(0, 1000) : '',
    body: typeof p.body === 'string' ? p.body.slice(0, 65_536) : null,
    headRef: head.ref.slice(0, 255),
    headSha: head.sha.slice(0, 64),
    baseRef: base.ref.slice(0, 255),
    state: p.state === 'open' ? 'open' : merged ? 'merged' : 'closed',
    htmlUrl,
  };
}
