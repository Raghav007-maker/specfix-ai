/**
 * Reading a Playwright JSON report (`--reporter=json`) into per-scenario results.
 *
 * A test belongs to a SpecFix scenario when it carries an `@sf-<scenario uuid>` tag the
 * scaffold emits (Playwright lists tags on each spec; a tag written into the title is
 * accepted too). A test may cover several scenarios — every tagged id gets the result.
 * Tests without a tag are counted as unmatched and otherwise ignored.
 *
 * Status is fail-closed. Playwright's per-test verdict maps expected → passed,
 * unexpected → failed, flaky → flaky (passed on retry), skipped → skipped (including
 * test.fixme). A missing or unrecognised verdict is derived from the last attempt's
 * result, and anything that is not clearly passed or skipped counts as failed — a broken
 * or custom reporter must never make a scenario look green.
 *
 * The report is untrusted input from CI: members of the wrong type are ignored rather
 * than crashing the parse, nesting is walked iteratively (no depth limit, no stack
 * overflow), durations are finite, and error text is stripped of terminal escape
 * sequences and control characters (including NUL, which Postgres text cannot store).
 */

export type CiStatus = 'passed' | 'failed' | 'flaky' | 'skipped';

export interface CiScenarioResult {
  scenarioId: string;
  status: CiStatus;
  durationMs: number;
  /** First line(s) of the failure message, cleaned. Null unless failed. */
  error: string | null;
}

export interface ParsedCiReport {
  results: CiScenarioResult[];
  unmatched: number;
}

/** The report is not something SpecFix can read. Its message is safe to show the caller. */
export class CiReportError extends Error {}

const TAG = /@sf-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi;
const RANK: Record<CiStatus, number> = { failed: 3, flaky: 2, passed: 1, skipped: 0 };
const VERDICT: Record<string, CiStatus> = {
  expected: 'passed',
  unexpected: 'failed',
  flaky: 'flaky',
  skipped: 'skipped',
};

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const asObject = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export function parsePlaywrightReport(report: unknown): ParsedCiReport {
  const root = asObject(report);
  if (!root || !Array.isArray(root.suites)) {
    throw new CiReportError('Not a Playwright JSON report: expected a top-level "suites" array.');
  }
  const byScenario = new Map<string, CiScenarioResult>();
  let unmatched = 0;

  // Iterative walk: arbitrarily deep reports neither overflow the stack nor lose tests.
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const suite = asObject(stack.pop());
    if (!suite) continue;
    for (const rawSpec of asArray(suite.specs)) {
      const spec = asObject(rawSpec);
      if (!spec) continue;
      const ids = scenarioIds(spec);
      for (const rawTest of asArray(spec.tests)) {
        const test = asObject(rawTest);
        if (!test) continue;
        if (ids.length === 0) {
          unmatched += 1;
          continue;
        }
        const outcome = toOutcome(test);
        for (const scenarioId of ids) {
          // The same scenario run in several projects (browsers): the worst outcome wins.
          const prior = byScenario.get(scenarioId);
          if (!prior) {
            byScenario.set(scenarioId, { scenarioId, ...outcome });
          } else if (RANK[outcome.status] > RANK[prior.status]) {
            byScenario.set(scenarioId, {
              scenarioId,
              ...outcome,
              durationMs: outcome.durationMs + prior.durationMs,
            });
          } else {
            prior.durationMs += outcome.durationMs;
          }
        }
      }
    }
    // Pushed in reverse so suites are still visited in report order.
    const children = asArray(suite.suites);
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }

  return { results: [...byScenario.values()], unmatched };
}

/** Every distinct scenario id tagged on the spec; tags win over the title. */
function scenarioIds(spec: Record<string, unknown>): string[] {
  const fromTags = asArray(spec.tags)
    .filter((t): t is string => typeof t === 'string')
    .flatMap((t) => matchIds(`@${t.replace(/^@/, '')}`));
  const ids =
    fromTags.length > 0 ? fromTags : matchIds(typeof spec.title === 'string' ? spec.title : '');
  return [...new Set(ids)];
}

function matchIds(text: string): string[] {
  return [...text.matchAll(TAG)].map((m) => m[1]!.toLowerCase());
}

function toOutcome(test: Record<string, unknown>): Omit<CiScenarioResult, 'scenarioId'> {
  const results = asArray(test.results)
    .map(asObject)
    .filter((r): r is Record<string, unknown> => r !== null);
  const last = results.at(-1);

  let status = typeof test.status === 'string' ? VERDICT[test.status] : undefined;
  if (!status) {
    // No usable verdict: derive it from the last attempt, failing closed.
    const lastStatus = typeof last?.status === 'string' ? last.status : '';
    status = lastStatus === 'passed' ? 'passed' : lastStatus === 'skipped' ? 'skipped' : 'failed';
  }

  const durationMs = results.reduce<number>((sum, r) => {
    const d = r.duration;
    return typeof d === 'number' && Number.isFinite(d) ? sum + d : sum;
  }, 0);

  let error: string | null = null;
  if (status === 'failed') {
    const message =
      textOf(asObject(last?.error)?.message) ??
      textOf(asObject(asArray(last?.errors)[0])?.message) ??
      '';
    error = cleanError(message);
  }
  return { status, durationMs, error };
}

function textOf(value: unknown): string | null {
  if (typeof value === 'string') return value === '' ? null : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

/** Terminal escape sequences and control characters removed; first 4 lines, 500 chars. */
export function cleanError(message: string): string | null {
  const cleaned = message
    // CSI sequences (colours, cursor movement, erase line)
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    // OSC sequences (hyperlinks, titles), ended by BEL or ESC \
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    // Any other two-character escape
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b[@-_]/g, '')
    // Remaining control characters except tab and newline (NUL included)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
  return cleaned.split('\n').slice(0, 4).join('\n').trim().slice(0, 500) || null;
}
