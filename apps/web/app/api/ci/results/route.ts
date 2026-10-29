import { NextResponse, type NextRequest } from 'next/server';
import { CiReportError, parsePlaywrightReport } from '@specfix/ingest';
import { notifyTicketEvent, recordCiRun, resolveCiToken } from '@/lib/repos';
import { readLimited } from '@/lib/read-limited';

/**
 * Receives a CI run's Playwright JSON report.
 *
 * Build the body with jq, never by pasting values into a JSON string — a branch name may
 * legally contain quotes, and a large report would exceed the shell's argument limit:
 *
 *   jq -n --arg c "$GITHUB_SHA" --arg b "$GITHUB_REF_NAME" --slurpfile r results.json \
 *     '{commit:$c, branch:$b, report:$r[0]}' |
 *   curl -sf --max-time 60 -X POST "$SPECFIX_URL/api/ci/results" \
 *     -H "Authorization: Bearer $SPECFIX_CI_TOKEN" -H "Content-Type: application/json" \
 *     --data-binary @-
 *
 * On a pull request, send the PR's head commit and branch rather than GitHub's merge
 * ref, plus `repository` ($GITHUB_REPOSITORY) and `pullRequest` (the PR number) when the
 * project has more than one mapped repository. Only runs on the repository's default
 * branch set a ticket's CI status; PR runs are shown on the PR and its check run.
 *
 * The token (one per project, from Settings → Integrations) decides the workspace and
 * project. Tests are matched to scenarios by their `@sf-<id>` tag; results for scenarios
 * outside the token's project are ignored. A raw Playwright file (top-level `suites`) is
 * accepted too.
 *
 * Untrusted input, so: the token is checked before the body is read; the body is read as
 * a stream and abandoned once it passes 5 MB of bytes (chunked uploads have no
 * Content-Length to trust); and callers only ever see fixed messages, never internal
 * error text.
 */
const MAX_BODY_BYTES = 5_000_000;

const fail = (status: number, error: string) => NextResponse.json({ error }, { status });

export async function POST(request: NextRequest) {
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '');
  const scope = match?.[1] ? await resolveCiToken(match[1]) : null;
  if (!scope) return fail(401, 'Unknown or revoked CI token.');

  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) return fail(413, 'Report is larger than 5 MB.');

  const raw = await readLimited(request, MAX_BODY_BYTES);
  if (raw === null) return fail(413, 'Report is larger than 5 MB.');

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return fail(400, 'Body is not JSON.');
  }
  const wrapper =
    typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  if (!wrapper) return fail(400, 'Not a Playwright JSON report.');

  let parsed;
  try {
    parsed = parsePlaywrightReport(wrapper.report ?? wrapper);
  } catch (error) {
    if (error instanceof CiReportError) return fail(400, error.message);
    console.error('[ci] report parse failed', error);
    return fail(400, 'Not a Playwright JSON report.');
  }

  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const prNumber = (v: unknown) => {
    const n = typeof v === 'string' && /^\d{1,9}$/.test(v.trim()) ? Number(v) : v;
    return typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : null;
  };
  let recorded;
  try {
    recorded = await recordCiRun(scope.tenant_id, scope.project_id, {
      commitSha: text(wrapper.commit),
      branch: text(wrapper.branch),
      runUrl: text(wrapper.runUrl),
      repository: text(wrapper.repository),
      pullRequest: prNumber(wrapper.pullRequest),
      results: parsed.results,
      unmatched: parsed.unmatched,
      tokenHash: scope.token_hash,
    });
  } catch (error) {
    console.error('[ci] storing run failed', error);
    return fail(500, 'Could not store the run. Try again later.');
  }

  // The run is stored; notifications are best effort. Failing here must not answer 500,
  // or CI would retry and record the same run twice.
  for (const t of recorded.failedTickets) {
    try {
      await notifyTicketEvent(scope.tenant_id, {
        kind: 'ci_failed',
        ticketId: t.ticket_id,
        details: {
          failed: t.failed,
          total: t.total,
          commit: text(wrapper.commit)?.slice(0, 12) ?? null,
        },
      });
    } catch (error) {
      console.error('[ci] notification failed', error);
    }
  }

  return NextResponse.json(
    { run: recorded.runId, matched: recorded.matched, unmatched: recorded.unmatched },
    { status: 201 }
  );
}
