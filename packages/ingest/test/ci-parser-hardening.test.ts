/**
 * Phase 3 hardening: edge cases of parsePlaywrightReport. Pure — no database.
 *
 * Tests named `fixed: …` were found failing by the hardening pass and fixed; they stay
 * as regression tests for those defects.
 */
import { describe, expect, it } from 'vitest';
import { parsePlaywrightReport } from '@specfix/ingest';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

interface T {
  status?: unknown;
  results?: unknown;
}
const spec = (title: string, tags: unknown, tests: T[]) => ({ title, tags, tests });
const run = (status: string, extra: Record<string, unknown> = {}) => ({
  status,
  results: [{ status: status === 'unexpected' ? 'failed' : 'passed', duration: 10, ...extra }],
});
const rep = (...specs: unknown[]) => ({ suites: [{ title: 'f.spec.ts', specs }] });

describe('report shape', () => {
  it.each([
    ['null', null],
    ['a string', 'suites'],
    ['a number', 42],
    ['an array', []],
    ['suites as object', { suites: {} }],
    ['suites as string', { suites: 'x' }],
    ['no suites', { config: {} }],
  ])('rejects %s with the "Not a Playwright JSON report" message', (_name, input) => {
    expect(() => parsePlaywrightReport(input)).toThrow(/Not a Playwright JSON report/);
  });

  it('accepts an empty report', () => {
    expect(parsePlaywrightReport({ suites: [] })).toEqual({ results: [], unmatched: 0 });
  });

  it('accepts suites with no specs, no tests, missing fields', () => {
    const parsed = parsePlaywrightReport({
      suites: [{}, { specs: [] }, { specs: [{}] }, { specs: [{ tests: [] }] }, { suites: [{}] }],
    });
    expect(parsed).toEqual({ results: [], unmatched: 0 });
  });

  it('counts each test of an untagged spec as unmatched (one per browser)', () => {
    const parsed = parsePlaywrightReport(
      rep(spec('plain', [], [run('expected'), run('expected')]))
    );
    expect(parsed.unmatched).toBe(2);
  });

  // Malformed members are ignored, not fatal: one bad entry must not reject the whole
  // report, and no raw TypeError may reach the caller.
  it.each([
    ['specs as object', { suites: [{ specs: {} }] }],
    ['tests as object', { suites: [{ specs: [{ tags: [`sf-${A}`], tests: {} }] }] }],
    ['suite null', { suites: [null] }],
    ['tags as string', { suites: [{ specs: [{ tags: `sf-${A}`, tests: [run('expected')] }] }] }],
    ['tag null', { suites: [{ specs: [{ tags: [null], tests: [run('expected')] }] }] }],
    [
      'results as string',
      {
        suites: [{ specs: [{ tags: [`sf-${A}`], tests: [{ status: 'expected', results: 'x' }] }] }],
      },
    ],
  ])('malformed %s is ignored without throwing', (_n, input) => {
    expect(() => parsePlaywrightReport(input)).not.toThrow();
  });

  it('a non-string title is coerced, a numeric title never matches', () => {
    const parsed = parsePlaywrightReport({
      suites: [{ specs: [{ title: 123, tests: [run('expected')] }] }],
    });
    expect(parsed).toEqual({ results: [], unmatched: 1 });
  });

  it('survives 50 levels of nesting (root + 50 suites)', () => {
    let suite: Record<string, unknown> = { specs: [spec('x', [`sf-${A}`], [run('expected')])] };
    for (let i = 0; i < 49; i++) suite = { suites: [suite] };
    expect(parsePlaywrightReport({ suites: [suite] }).results).toHaveLength(1);
  });

  it('a 10,000-level deep report does not overflow the stack', () => {
    let suite: Record<string, unknown> = { specs: [spec('x', [`sf-${A}`], [run('expected')])] };
    for (let i = 0; i < 10_000; i++) suite = { suites: [suite] };
    expect(() => parsePlaywrightReport({ suites: [suite] })).not.toThrow();
  });

  it('fixed: tests nested deeper than 50 suites are dropped without being counted', () => {
    let suite: Record<string, unknown> = { specs: [spec('x', [`sf-${A}`], [run('expected')])] };
    for (let i = 0; i < 60; i++) suite = { suites: [suite] };
    const parsed = parsePlaywrightReport({ suites: [suite] });
    // Expected: the test is either reported or at least counted as unmatched.
    expect(parsed.results.length + parsed.unmatched).toBe(1);
  });

  it('handles 20,000 tagged specs (wide report) quickly', () => {
    const specs = Array.from({ length: 20_000 }, (_, i) =>
      spec(`t${i}`, [`sf-${A.slice(0, 24)}${String(i).padStart(12, '0')}`], [run('expected')])
    );
    const started = Date.now();
    const parsed = parsePlaywrightReport({ suites: [{ specs }] });
    expect(parsed.results).toHaveLength(20_000);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('tags', () => {
  it.each([
    ['tag with @', [`@sf-${A}`], 'x'],
    ['tag without @ (Playwright JSON strips it)', [`sf-${A}`], 'x'],
    ['tag only in title', [], `adds items @sf-${A}`],
    ['uppercase uuid in tag', [`sf-${A.toUpperCase()}`], 'x'],
    ['uppercase SF prefix', [`@SF-${A}`], 'x'],
    ['tag among other tags', ['smoke', `sf-${A}`, 'slow'], 'x'],
  ])('%s matches and lowercases the id', (_n, tags, title) => {
    const parsed = parsePlaywrightReport(rep(spec(title, tags, [run('expected')])));
    expect(parsed.results.map((r) => r.scenarioId)).toEqual([A]);
  });

  it.each([
    ['sf- in title without @', [], `adds sf-${A}`],
    ['truncated uuid', [`sf-${A.slice(0, 35)}`], 'x'],
    ['non-hex uuid', [`sf-${A.replace(/1/g, 'g')}`], 'x'],
    ['uuid followed by word chars', [`sf-${A}abc`], 'x'],
    ['different prefix', [`@spec-${A}`], 'x'],
  ])('%s does not match', (_n, tags, title) => {
    const parsed = parsePlaywrightReport(rep(spec(title, tags, [run('expected')])));
    expect(parsed).toEqual({ results: [], unmatched: 1 });
  });

  it('tag inside another word (foo@sf-<id>) still matches — no leading boundary', () => {
    const parsed = parsePlaywrightReport(rep(spec(`foo@sf-${A}`, [], [run('expected')])));
    expect(parsed.results).toHaveLength(1);
  });

  it('the tags array wins over a different id in the title', () => {
    const parsed = parsePlaywrightReport(rep(spec(`t @sf-${B}`, [`sf-${A}`], [run('expected')])));
    expect(parsed.results.map((r) => r.scenarioId)).toEqual([A]);
  });

  it('fixed: a test tagged with two scenarios reports only the first', () => {
    const parsed = parsePlaywrightReport(
      rep(spec('covers two', [`sf-${A}`, `sf-${B}`], [run('unexpected')]))
    );
    expect(parsed.results.map((r) => r.scenarioId).sort()).toEqual([A, B]);
  });
});

describe('status mapping and precedence', () => {
  it.each([
    ['expected', 'passed'],
    ['unexpected', 'failed'],
    ['flaky', 'flaky'],
    ['skipped', 'skipped'],
  ])('%s → %s', (status, want) => {
    const parsed = parsePlaywrightReport(rep(spec('x', [`sf-${A}`], [run(status)])));
    expect(parsed.results[0]!.status).toBe(want);
  });

  it('test.fixme (status skipped, result skipped, no duration) is skipped, not passed', () => {
    const parsed = parsePlaywrightReport(
      rep(spec('x', [`sf-${A}`], [{ status: 'skipped', results: [{ status: 'skipped' }] }]))
    );
    expect(parsed.results).toEqual([
      { scenarioId: A, status: 'skipped', durationMs: 0, error: null },
    ]);
  });

  it.each([
    ['missing status', { results: [{ status: 'failed', error: { message: 'boom' } }] }],
    ['status timedOut', { status: 'timedOut', results: [{ status: 'timedOut' }] }],
    ['status interrupted', { status: 'interrupted', results: [{ status: 'interrupted' }] }],
    ['status FAILED (unknown value)', { status: 'FAILED', results: [] }],
  ])('fixed: %s is reported as passed (fail-open)', (_n, test) => {
    const parsed = parsePlaywrightReport(rep(spec('x', [`sf-${A}`], [test])));
    expect(parsed.results[0]!.status).not.toBe('passed');
  });

  it.each([
    [['expected', 'unexpected'], 'failed'],
    [['unexpected', 'expected'], 'failed'],
    [['flaky', 'unexpected'], 'failed'],
    [['expected', 'flaky'], 'flaky'],
    [['skipped', 'expected'], 'passed'],
    [['skipped', 'unexpected'], 'failed'],
    [['skipped', 'skipped'], 'skipped'],
  ])('across browsers %j → %s', (statuses, want) => {
    const parsed = parsePlaywrightReport(
      rep(
        spec(
          'x',
          [`sf-${A}`],
          statuses.map((s) => run(s))
        )
      )
    );
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0]!.status).toBe(want);
    expect(parsed.results[0]!.durationMs).toBe(20);
  });

  it('the same scenario in two different specs/files merges into one result', () => {
    const parsed = parsePlaywrightReport({
      suites: [
        { specs: [spec('a', [`sf-${A}`], [run('expected')])] },
        {
          suites: [
            { specs: [spec('b', [`sf-${A}`], [run('unexpected', { error: { message: 'x' } })])] },
          ],
        },
      ],
    });
    expect(parsed.results).toEqual([
      { scenarioId: A, status: 'failed', durationMs: 20, error: 'x' },
    ]);
  });

  it('the first failing browser keeps its error when a second one also fails', () => {
    const parsed = parsePlaywrightReport(
      rep(
        spec(
          'x',
          [`sf-${A}`],
          [
            run('unexpected', { error: { message: 'chromium' } }),
            run('unexpected', { error: { message: 'firefox' } }),
          ]
        )
      )
    );
    expect(parsed.results[0]!.error).toBe('chromium');
  });
});

describe('durations', () => {
  const withDurations = (...d: unknown[]) =>
    parsePlaywrightReport(
      rep(
        spec('x', [`sf-${A}`], [{ status: 'flaky', results: d.map((duration) => ({ duration })) }])
      )
    ).results[0]!.durationMs;

  it('sums retries', () => expect(withDurations(10, 20, 30)).toBe(60));
  it('ignores non-numeric durations', () => expect(withDurations('10', null, {}, 5)).toBe(5));
  it('passes negative durations through (clamped only at insert)', () =>
    expect(withDurations(-100, 50)).toBe(-50));

  it('fixed: NaN/Infinity durations are passed through (typeof NaN === "number")', () => {
    expect(Number.isFinite(withDurations(Number.NaN, 5))).toBe(true);
    // JSON.parse('1e400') === Infinity, so this is reachable from an HTTP body.
    expect(Number.isFinite(withDurations(JSON.parse('1e400'), 5))).toBe(true);
  });
});

describe('error extraction', () => {
  const errorOf = (result: Record<string, unknown>, status = 'unexpected') =>
    parsePlaywrightReport(rep(spec('x', [`sf-${A}`], [{ status, results: [result] }]))).results[0]!
      .error;

  it('reads error.message', () => expect(errorOf({ error: { message: 'boom' } })).toBe('boom'));
  it('falls back to errors[0].message', () =>
    expect(errorOf({ errors: [{ message: 'first' }, { message: 'second' }] })).toBe('first'));
  it('prefers error over errors[]', () =>
    expect(errorOf({ error: { message: 'a' }, errors: [{ message: 'b' }] })).toBe('a'));
  it('no message at all → null', () => expect(errorOf({})).toBeNull());
  it('whitespace-only message → null', () =>
    expect(errorOf({ error: { message: '  \n ' } })).toBeNull());
  it('no error for passed/flaky/skipped tests', () => {
    expect(errorOf({ error: { message: 'x' } }, 'flaky')).toBeNull();
    expect(errorOf({ error: { message: 'x' } }, 'skipped')).toBeNull();
  });
  it('failed test with no results → null error, 0 duration', () => {
    const parsed = parsePlaywrightReport(rep(spec('x', [`sf-${A}`], [{ status: 'unexpected' }])));
    expect(parsed.results[0]).toEqual({
      scenarioId: A,
      status: 'failed',
      durationMs: 0,
      error: null,
    });
  });
  it('reads the LAST result (final retry)', () =>
    expect(
      parsePlaywrightReport(
        rep(
          spec(
            'x',
            [`sf-${A}`],
            [
              {
                status: 'unexpected',
                results: [{ error: { message: 'try 1' } }, { error: { message: 'try 2' } }],
              },
            ]
          )
        )
      ).results[0]!.error
    ).toBe('try 2'));
  it('strips SGR ANSI codes', () =>
    expect(
      errorOf({ error: { message: '\u001b[31mred\u001b[39m \u001b[1;2mbold\u001b[0m' } })
    ).toBe('red bold'));
  it('keeps only the first 4 lines', () =>
    expect(errorOf({ error: { message: 'l1\nl2\nl3\nl4\nl5\nl6' } })).toBe('l1\nl2\nl3\nl4'));
  it('truncates to 500 chars', () =>
    expect(errorOf({ error: { message: 'x'.repeat(100_000) } })!.length).toBe(500));
  it('a 5 MB single-line message of escape junk is handled in linear time', () => {
    const started = Date.now();
    // Nothing but escape sequences: everything is stripped, so there is no message left.
    expect(errorOf({ error: { message: '\u001b['.repeat(1_000_000) } })).toBeNull();
    expect(errorOf({ error: { message: 'x'.repeat(5_000_000) } })!.length).toBe(500);
    expect(Date.now() - started).toBeLessThan(2000);
  });
  it('truncation can split a surrogate pair (lone surrogate in output)', () => {
    const out = errorOf({ error: { message: 'x'.repeat(499) + '😀' } })!;
    expect(out.length).toBe(500);
    expect(out.charCodeAt(499)).toBe(0xd83d); // a lone high surrogate
  });
  it('strips NUL and other control characters (Postgres text rejects NUL)', () =>
    expect(errorOf({ error: { message: 'a\u0000b\u0007c\td' } })).toBe('abc\td'));
  it('keeps HTML as text (rendering is responsible for escaping)', () =>
    expect(errorOf({ error: { message: '<img src=x onerror=alert(1)>' } })).toBe(
      '<img src=x onerror=alert(1)>'
    ));
  it('an empty error.message falls back to errors[0].message', () =>
    expect(errorOf({ error: { message: '' }, errors: [{ message: 'real' }] })).toBe('real'));

  it('fixed: non-SGR escape sequences (cursor, OSC 8 links) are not stripped', () => {
    const out = errorOf({
      error: { message: '\u001b[2Kline \u001b]8;;https://x\u0007link\u001b]8;;\u0007' },
    });
    // eslint-disable-next-line no-control-regex
    expect(out).not.toMatch(/\u001b/);
  });

  it('fixed: a non-string error.message rejects the whole report with a TypeError', () => {
    expect(() => errorOf({ error: { message: 42 } })).not.toThrow();
  });
});
