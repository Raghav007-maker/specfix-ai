/**
 * The random-pruning control.
 *
 * These tests are the check on the check. `runControl` exists to make the Critic
 * claim refutable, so the tests it needs are the ones that show it *can* refute:
 * a Critic that prunes well must pass, and a Critic that prunes at random must fail
 * even though its precision went up. If only the first held, the control would be
 * the same unfalsifiable claim it replaced, wearing a p-value.
 */
import { describe, it, expect } from 'vitest';
import type { AnalyzedFlag } from '@specfix/core';
import {
  runControl,
  DEFAULT_ITERATIONS,
  DEFAULT_SEED,
  SIGNIFICANCE_THRESHOLD,
} from '../src/control.ts';
import type { GoldSet } from '../src/gold.ts';
import type { TicketRun } from '../src/score.ts';

const REVIEWER = 'pm-a';
const SCOPE = { reviewerIds: [REVIEWER] };

function flag(dedupeKey: string): AnalyzedFlag {
  return {
    category: 'missing_info',
    quoted_span: '',
    what_unclear: dedupeKey,
    why_it_matters: 'because',
    question_for_pm: 'which?',
    severity: 'medium',
    dedupeKey,
    spanVerified: true,
  };
}

interface CandSpec {
  key: string;
  judged?: 'real' | 'noise';
  covers?: string[];
}

interface TicketSpec {
  externalId: string;
  kept?: CandSpec[];
  pruned?: CandSpec[];
  /** Verdicts the gold set holds for flags this run never produced. */
  unproduced?: CandSpec[];
  gaps?: string[];
  error?: string;
}

function build(specs: readonly TicketSpec[]): { set: GoldSet; runs: TicketRun[] } {
  const set: GoldSet = {
    version: 'gold-control',
    frozen: true,
    frozenAt: '2026-09-01',
    ticketsDir: '../tickets/sample',
    notes: '',
    reviewers: [{ id: REVIEWER, role: 'pm', independentOfPrompt: true }],
    tickets: specs.map((spec) => ({
      externalId: spec.externalId,
      gaps: (spec.gaps ?? []).map((id) => ({
        id,
        reviewerId: REVIEWER,
        description: `gap ${id}`,
      })),
      verdicts: [...(spec.kept ?? []), ...(spec.pruned ?? []), ...(spec.unproduced ?? [])]
        .filter((c) => c.judged !== undefined)
        .map((c) => ({
          dedupeKey: c.key,
          verdict: c.judged as 'real' | 'noise',
          reviewerId: REVIEWER,
          coversGapIds: c.covers ?? [],
          label: '',
          note: '',
        })),
    })),
  };

  const runs: TicketRun[] = specs.map((spec) => ({
    externalId: spec.externalId,
    flags: (spec.kept ?? []).map((c) => flag(c.key)),
    prunedFlags: (spec.pruned ?? []).map((c) => flag(c.key)),
    costUsd: 0.001,
    truncated: false,
    unverifiedSpans: 0,
    ...(spec.error === undefined ? {} : { error: spec.error }),
  }));

  return { set, runs };
}

/** n tickets, each with two real and two noise candidates. */
function fourCandidateTickets(n: number, prunes: 'noise' | 'mixed'): TicketSpec[] {
  return Array.from({ length: n }, (_, i) => {
    const t = `T-${i}`;
    const real: CandSpec[] = [
      { key: `${t}-r1`, judged: 'real' },
      { key: `${t}-r2`, judged: 'real' },
    ];
    const noise: CandSpec[] = [
      { key: `${t}-n1`, judged: 'noise' },
      { key: `${t}-n2`, judged: 'noise' },
    ];
    return prunes === 'noise'
      ? { externalId: t, kept: real, pruned: noise }
      : // Volume-identical, but the choice is uninformed: one real and one noise go.
        {
          externalId: t,
          kept: [real[0] as CandSpec, noise[0] as CandSpec],
          pruned: [real[1] as CandSpec, noise[1] as CandSpec],
        };
  });
}

describe('runControl', () => {
  it('finds a Critic that pruned exactly the noise to beat chance', () => {
    const { set, runs } = build(fourCandidateTickets(4, 'noise'));
    const result = runControl(set, runs, SCOPE);

    expect(result.applicable).toBe(true);
    expect(result.observedPrecision).toBe(1);
    // Keeping two of four at random gets both reals one time in six, per ticket.
    expect(result.nullMeanPrecision).toBeGreaterThan(0.4);
    expect(result.nullMeanPrecision).toBeLessThan(0.6);
    expect(result.pValue).toBeLessThan(SIGNIFICANCE_THRESHOLD);
    expect(result.significant).toBe(true);
    expect(result.lift).toBeGreaterThan(0.3);
  });

  it('finds a Critic that pruned at random NOT to beat chance, though its precision rose', () => {
    // This is the case the whole module exists for. Precision here is 0.50, up from
    // the 0.50 of the full candidate list only because... it isn't up at all — and
    // that is exactly what a precision-only objective would have failed to notice
    // in the version of this test where the ratios did shift.
    const { set, runs } = build(fourCandidateTickets(4, 'mixed'));
    const result = runControl(set, runs, SCOPE);

    expect(result.applicable).toBe(true);
    expect(result.observedPrecision).toBe(0.5);
    expect(result.significant).toBe(false);
    expect(result.pValue).toBeGreaterThan(SIGNIFICANCE_THRESHOLD);
    expect(Math.abs(result.lift as number)).toBeLessThan(0.1);
  });

  it('fails a Critic whose precision improved over the unpruned list but not over chance', () => {
    // Six candidates per ticket, two real. Keeping two-of-six at random averages the
    // same 1/3 as the full list, so raising precision to 0.5 by pruning four is only
    // impressive if it beats the draw — and one lucky real in each keep does not.
    const specs: TicketSpec[] = Array.from({ length: 3 }, (_, i) => {
      const t = `T-${i}`;
      return {
        externalId: t,
        kept: [
          { key: `${t}-r1`, judged: 'real' },
          { key: `${t}-n1`, judged: 'noise' },
        ],
        pruned: [
          { key: `${t}-r2`, judged: 'real' },
          { key: `${t}-n2`, judged: 'noise' },
          { key: `${t}-n3`, judged: 'noise' },
          { key: `${t}-n4`, judged: 'noise' },
        ],
      };
    });

    const result = runControl(build(specs).set, build(specs).runs, SCOPE);

    // Precision over the full candidate list would have been 6/18 = 0.33.
    expect(result.observedPrecision).toBeCloseTo(0.5, 6);
    // Up 17 points on the unpruned list, and still indistinguishable from luck.
    expect(result.significant).toBe(false);
  });

  it('never reports p = 0, however cleanly the Critic separated the two groups', () => {
    // Ten tickets pruned perfectly: no random draw in a thousand will match it. An
    // unadjusted count would print 0.000 and claim certainty a finite resample cannot
    // support; the Phipson–Smyth +1 floors it at 1/(iterations+1).
    const { set, runs } = build(fourCandidateTickets(10, 'noise'));
    const result = runControl(set, runs, SCOPE);

    expect(result.pValue).toBeGreaterThan(0);
    expect(result.pValue).toBeGreaterThanOrEqual(1 / (DEFAULT_ITERATIONS + 1));
  });

  it('matches the volume it prunes, and says how much that was', () => {
    const { set, runs } = build(fourCandidateTickets(4, 'noise'));
    const result = runControl(set, runs, SCOPE);

    expect(result.candidatesTotal).toBe(16);
    expect(result.prunedTotal).toBe(8);
    expect(result.judgedSurvivors).toBe(8);
    expect(result.iterations).toBe(DEFAULT_ITERATIONS);
    expect(result.seed).toBe(DEFAULT_SEED);
  });

  it('returns the same p-value on a re-run, so a report is reproducible', () => {
    const { set, runs } = build(fourCandidateTickets(4, 'mixed'));
    const a = runControl(set, runs, SCOPE);
    const b = runControl(set, runs, SCOPE);

    expect(b.pValue).toBe(a.pValue);
    expect(b.nullMeanPrecision).toBe(a.nullMeanPrecision);
  });

  it('leaves the observed figure untouched when the seed changes', () => {
    const { set, runs } = build(fourCandidateTickets(4, 'mixed'));
    const a = runControl(set, runs, { ...SCOPE, seed: 1 });
    const b = runControl(set, runs, { ...SCOPE, seed: 2 });

    expect(b.observedPrecision).toBe(a.observedPrecision);
    // Only the null moves, and only a little at a thousand draws.
    expect(
      Math.abs((b.nullMeanPrecision as number) - (a.nullMeanPrecision as number))
    ).toBeLessThan(0.05);
  });

  it('declines the test when the Critic pruned nothing', () => {
    const { set, runs } = build([
      {
        externalId: 'T-0',
        kept: [
          { key: 'a', judged: 'real' },
          { key: 'b', judged: 'noise' },
        ],
      },
    ]);
    const result = runControl(set, runs, SCOPE);

    expect(result.applicable).toBe(false);
    expect(result.reason).toMatch(/pruned nothing/);
    expect(result.pValue).toBeNull();
    expect(result.significant).toBe(false);
    // Precision is still defined and still reported; it just is not evidence.
    expect(result.observedPrecision).toBe(0.5);
  });

  it('declines the test when no surviving flag has been judged', () => {
    const { set, runs } = build([
      { externalId: 'T-0', kept: [{ key: 'a' }], pruned: [{ key: 'b', judged: 'noise' }] },
    ]);
    const result = runControl(set, runs, SCOPE);

    expect(result.applicable).toBe(false);
    expect(result.reason).toMatch(/undefined/);
    expect(result.observedPrecision).toBeNull();
    expect(result.pValue).toBeNull();
  });

  it('reports a gap that only a pruned flag covered', () => {
    const { set, runs } = build([
      {
        externalId: 'T-0',
        gaps: ['g1'],
        kept: [{ key: 'kept-noise', judged: 'noise' }],
        pruned: [{ key: 'the-find', judged: 'real', covers: ['g1'] }],
      },
    ]);
    const result = runControl(set, runs, SCOPE);

    expect(result.gapsLostToPruning).toHaveLength(1);
    expect(result.gapsLostToPruning[0]?.gapId).toBe('g1');
    expect(result.gapsLostToPruning[0]?.externalId).toBe('T-0');
    expect(result.gapsLostToPruning[0]?.prunedBy[0]?.dedupeKey).toBe('the-find');
  });

  it('does not call a gap lost when a surviving flag also covers it', () => {
    const { set, runs } = build([
      {
        externalId: 'T-0',
        gaps: ['g1'],
        kept: [{ key: 'survivor', judged: 'real', covers: ['g1'] }],
        pruned: [{ key: 'duplicate', judged: 'real', covers: ['g1'] }],
      },
    ]);
    // The reviewer still gets asked about g1, so nothing was lost.
    expect(runControl(set, runs, SCOPE).gapsLostToPruning).toEqual([]);
  });

  it('does not blame the Critic for a gap the Extractor never found', () => {
    const { set, runs } = build([
      {
        externalId: 'T-0',
        gaps: ['g1'],
        kept: [{ key: 'a', judged: 'noise' }],
        pruned: [{ key: 'b', judged: 'noise' }],
        unproduced: [{ key: 'never-emitted', judged: 'real', covers: ['g1'] }],
      },
    ]);
    // g1 is a miss, and `scoreRun`'s recall already says so. Attributing it here too
    // would make one extraction failure fail two different checks.
    expect(runControl(set, runs, SCOPE).gapsLostToPruning).toEqual([]);
  });

  it('excludes an errored ticket, because an API outage is not evidence about the Critic', () => {
    const specs = fourCandidateTickets(2, 'noise');
    (specs[0] as TicketSpec).error = 'HTTP 500 after 3 attempts';
    const { set, runs } = build(specs);
    const result = runControl(set, runs, SCOPE);

    expect(result.candidatesTotal).toBe(4);
    expect(result.prunedTotal).toBe(2);
  });

  it('ignores a verdict from a reviewer outside the scored scope', () => {
    const { set, runs } = build([
      {
        externalId: 'T-0',
        kept: [{ key: 'a', judged: 'real' }, { key: 'b' }],
        pruned: [{ key: 'c', judged: 'noise' }],
      },
    ]);
    set.reviewers.push({ id: 'pm-b', role: 'pm', independentOfPrompt: true });
    set.tickets[0]?.verdicts.push({
      dedupeKey: 'b',
      verdict: 'noise',
      reviewerId: 'pm-b',
      coversGapIds: [],
      label: '',
      note: '',
    });

    // Scored against pm-a alone, `b` is unjudged: one real of one judged survivor.
    const scoped = runControl(set, runs, SCOPE);
    expect(scoped.judgedSurvivors).toBe(1);
    expect(scoped.observedPrecision).toBe(1);

    // Widening the scope pulls pm-b's verdict in, which is why the CLI must pass the
    // scope the scorecard resolved rather than the one the user asked for.
    const wide = runControl(set, runs, { reviewerIds: [REVIEWER, 'pm-b'] });
    expect(wide.judgedSurvivors).toBe(2);
    expect(wide.observedPrecision).toBe(0.5);
  });

  it('honours a reduced iteration count, for a fast test rather than a fast p-value', () => {
    const { set, runs } = build(fourCandidateTickets(4, 'noise'));
    const result = runControl(set, runs, { ...SCOPE, iterations: 50 });

    expect(result.iterations).toBe(50);
    expect(result.pValue).toBeGreaterThanOrEqual(1 / 51);
  });
});
