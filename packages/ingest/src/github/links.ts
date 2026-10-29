/**
 * Pure helpers for the GitHub side of the loop: finding Jira keys in a pull request,
 * turning CI results into a check-run verdict, and the text SpecFix posts.
 *
 * Everything posted to GitHub is built from SpecFix's own values (ticket keys, counts,
 * links) — never from ticket titles, scenario text or PR text, which are untrusted and
 * could carry markdown links or @mentions.
 */

export type PrLinkSource = 'branch' | 'title' | 'body';

/** Most keys considered per PR: a body listing hundreds of keys links none past this. */
const MAX_KEYS = 20;
/** PR bodies can be 65k characters; keys are looked for in the start of it only. */
const MAX_BODY_SCAN = 10_000;

const KEY = /(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9_]{1,9})-(\d{1,9})(?![A-Za-z0-9])/g;

/**
 * Jira-style keys (PROJ-123) in a PR's branch name, title and body, each with where it
 * was first found. Branches are matched case-insensitively (`feature/cart-12-limit` is
 * CART-12); title and body need the key in upper case, as Jira writes it, so ordinary
 * words like "utf-8" in prose do not become keys.
 */
export function jiraKeysInPullRequest(input: {
  branch: string;
  title: string;
  body: string | null;
}): Array<{ key: string; source: PrLinkSource }> {
  const found = new Map<string, PrLinkSource>();
  const scan = (text: string, source: PrLinkSource, anyCase: boolean) => {
    for (const m of text.matchAll(KEY)) {
      if (found.size >= MAX_KEYS) return;
      const project = m[1]!;
      if (!anyCase && project !== project.toUpperCase()) continue;
      const key = `${project.toUpperCase()}-${Number(m[2])}`;
      if (!found.has(key)) found.set(key, source);
    }
  };
  scan(input.branch.slice(0, 255), 'branch', true);
  scan(input.title.slice(0, 1000), 'title', false);
  scan((input.body ?? '').slice(0, MAX_BODY_SCAN), 'body', false);
  return [...found].map(([key, source]) => ({ key, source }));
}

export type CheckConclusion = 'success' | 'failure' | 'neutral';

export interface CheckSummary {
  conclusion: CheckConclusion;
  title: string;
  summary: string;
}

/**
 * The "SpecFix acceptance" verdict for one commit. Only approved scenarios of the PR's
 * linked tickets count. Flaky counts as passing (it passed on retry) but is named;
 * a scenario with no result is not passing. No approved scenarios, or none reported,
 * is neutral — there is nothing to judge, which must not read as a pass.
 */
export function summarizeAcceptance(input: {
  tickets: Array<{
    key: string;
    scenarios: Array<{ status: 'passed' | 'failed' | 'flaky' | 'skipped' | null }>;
  }>;
  detailsUrl?: string | null;
}): CheckSummary {
  const all = input.tickets.flatMap((t) => t.scenarios);
  const count = (s: string | null) => all.filter((x) => x.status === s).length;
  const passed = count('passed') + count('flaky');
  const failed = count('failed');
  const reported = all.filter((x) => x.status !== null).length;
  const total = all.length;

  const conclusion: CheckConclusion =
    total === 0 || reported === 0
      ? 'neutral'
      : failed > 0
        ? 'failure'
        : passed === total
          ? 'success'
          : 'neutral';
  const title =
    total === 0
      ? 'No approved scenarios for the linked tickets'
      : `${passed}/${total} scenario${total === 1 ? '' : 's'} passing`;

  const lines = [
    '| Ticket | Passing | Failed | Flaky | Not reported |',
    '|---|---|---|---|---|',
    ...input.tickets.map((t) => {
      const n = (s: string | null) => t.scenarios.filter((x) => x.status === s).length;
      return `| ${t.key} | ${n('passed') + n('flaky')}/${t.scenarios.length} | ${n('failed')} | ${n('flaky')} | ${n(null) + n('skipped')} |`;
    }),
  ];
  if (input.detailsUrl) lines.push('', `Details: ${input.detailsUrl}`);
  return { conclusion, title, summary: lines.join('\n') };
}

/** Marks SpecFix's own comment, so it can be recognised among the PR's comments. */
export const NOT_READY_MARKER = '<!-- specfix:not-ready -->';

/**
 * The PR comment warning that linked tickets are not ready for development. When every
 * linked ticket has become ready, the same comment is edited to say so instead of being
 * deleted, so the history of the warning stays visible on the PR.
 */
export function notReadyComment(input: {
  notReady: Array<{ key: string; url: string | null }>;
  ready: string[];
}): string {
  const link = (t: { key: string; url: string | null }) => (t.url ? `[${t.key}](${t.url})` : t.key);
  if (input.notReady.length === 0) {
    return [
      NOT_READY_MARKER,
      `**SpecFix:** every linked ticket (${input.ready.join(', ')}) is now ready for development.`,
    ].join('\n');
  }
  return [
    NOT_READY_MARKER,
    `**SpecFix:** ${input.notReady.length === 1 ? 'this ticket is' : 'these tickets are'} not marked "Ready for development" yet: ${input.notReady.map(link).join(', ')}.`,
    '',
    input.notReady.length === 1
      ? 'Its open questions may still change the acceptance criteria this PR is built against. Resolve the flags and sign the ticket off in SpecFix; this comment updates when that happens.'
      : 'Their open questions may still change the acceptance criteria this PR is built against. Resolve the flags and sign the tickets off in SpecFix; this comment updates when that happens.',
  ].join('\n');
}

/** A ticket key made safe for a branch name and a path segment. */
export function safeRefSegment(key: string): string {
  const cleaned = key
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^[.-]+/, '')
    .slice(0, 60);
  return cleaned.replace(/\.+$/, '').replace(/\.lock$/i, '') || 'ticket';
}
