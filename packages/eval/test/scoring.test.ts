import { describe, it, expect } from 'vitest';
import type { AnalyzedFlag } from '@specfix/core';
import type { FlagCategory } from '@specfix/shared';
import { scoreRun, type TicketRun } from '../src/score.ts';
import { buildReport, caveatsFor, diffReports, renderReport, reportPath } from '../src/report.ts';
import type { GoldSet, LoadedGoldSet } from '../src/gold.ts';
import type { RunSummary } from '../src/runner.ts';

function flag(dedupeKey: string, category: FlagCategory = 'missing_info'): AnalyzedFlag {
  return {
    category,
    quoted_span: '',
    what_unclear: dedupeKey,
    why_it_matters: 'because',
    question_for_pm: 'which?',
    severity: 'medium',
    dedupeKey,
    spanVerified: true,
  };
}

function run(externalId: string, keys: string[], overrides: Partial<TicketRun> = {}): TicketRun {
  return {
    externalId,
    flags: keys.map((k) => flag(k)),
    costUsd: 0.001,
    truncated: false,
    unverifiedSpans: 0,
    ...overrides,
  };
}

/**
 * One ticket, three flags. `k-real` was accepted and covers gap g1; `k-noise` was
 * dismissed; `k-new` has never been judged. g2 was never linked to anything, so it
 * is a miss.
 */
function baseSet(): GoldSet {
  return {
    version: 'gold-v1',
    frozen: true,
    frozenAt: '2026-08-31',
    ticketsDir: '../tickets/sample',
    notes: '',
    reviewers: [{ id: 'pm-a', role: 'pm', independentOfPrompt: true }],
    tickets: [
      {
        externalId: 'PAY-142',
        gaps: [
          { id: 'g1', reviewerId: 'pm-a', description: 'no currency' },
          { id: 'g2', reviewerId: 'pm-a', description: 'no partial-refund limit' },
        ],
        verdicts: [
          {
            dedupeKey: 'k-real',
            verdict: 'real',
            reviewerId: 'pm-a',
            coversGapIds: ['g1'],
            label: '',
            note: '',
          },
          {
            dedupeKey: 'k-noise',
            verdict: 'noise',
            reviewerId: 'pm-a',
            coversGapIds: [],
            label: '',
            note: '',
          },
        ],
      },
    ],
  };
}

describe('scoreRun', () => {
  it('computes precision over judged flags and leaves unjudged ones out', () => {
    const card = scoreRun(baseSet(), [run('PAY-142', ['k-real', 'k-noise', 'k-new'])]);

    expect(card.flagsProduced).toBe(3);
    expect(card.counts).toEqual({ real: 1, noise: 1, disputed: 0, unjudged: 1 });
    // 1 real of 2 judged. The unjudged flag is not a false positive.
    expect(card.precision.denominator).toBe(2);
    expect(card.precision.value).toBe(0.5);
  });

  it('counts an unlinked reviewer gap as a miss', () => {
    const card = scoreRun(baseSet(), [run('PAY-142', ['k-real', 'k-noise'])]);
    expect(card.recall.denominator).toBe(2);
    expect(card.recall.numerator).toBe(1);
    expect(card.gaps.find((g) => g.gapId === 'g1')?.covered).toBe(true);
    expect(card.gaps.find((g) => g.gapId === 'g2')?.covered).toBe(false);
  });

  it('does not credit coverage from a flag the run did not produce', () => {
    // k-real covers g1 in the gold set, but this run never emitted it. Recall must
    // reflect what the model actually said this time.
    const card = scoreRun(baseSet(), [run('PAY-142', ['k-noise'])]);
    expect(card.recall.numerator).toBe(0);
    expect(card.recall.denominator).toBe(2);
  });

  it('excludes a failed ticket from both precision and recall, and reports the failure', () => {
    const card = scoreRun(baseSet(), [
      run('PAY-142', [], { error: 'HTTP 500 after 3 attempts', costUsd: 0 }),
    ]);
    expect(card.ticketsFailed).toBe(1);
    expect(card.ticketsAnalyzed).toBe(0);
    // Blaming the prompt for an API outage would be the wrong reading.
    expect(card.recall.denominator).toBe(0);
    expect(card.precision.denominator).toBe(0);
    expect(card.flagsPerTicket).toBeNull();
  });

  it('reports a split verdict as disputed rather than picking a side', () => {
    const set = baseSet();
    set.reviewers.push({ id: 'pm-b', role: 'pm', independentOfPrompt: true });
    set.tickets[0]?.verdicts.push({
      dedupeKey: 'k-real',
      verdict: 'noise',
      reviewerId: 'pm-b',
      coversGapIds: [],
      label: '',
      note: '',
    });

    const card = scoreRun(set, [run('PAY-142', ['k-real'])]);
    expect(card.counts.disputed).toBe(1);
    expect(card.precision.denominator).toBe(0);
    // A disputed flag also forfeits its coverage claim.
    expect(card.gaps.every((g) => !g.covered)).toBe(true);
  });

  it('resolves a majority when more than two reviewers judged a flag', () => {
    const set = baseSet();
    set.reviewers.push(
      { id: 'pm-b', role: 'pm', independentOfPrompt: true },
      { id: 'pm-c', role: 'pm', independentOfPrompt: true }
    );
    const verdicts = set.tickets[0]?.verdicts as GoldSet['tickets'][number]['verdicts'];
    verdicts.push(
      {
        dedupeKey: 'k-real',
        verdict: 'noise',
        reviewerId: 'pm-b',
        coversGapIds: [],
        label: '',
        note: '',
      },
      {
        dedupeKey: 'k-real',
        verdict: 'real',
        reviewerId: 'pm-c',
        coversGapIds: ['g1'],
        label: '',
        note: '',
      }
    );

    const card = scoreRun(set, [run('PAY-142', ['k-real'])]);
    expect(card.counts.real).toBe(1);
    expect(card.gaps.find((g) => g.gapId === 'g1')?.covered).toBe(true);
  });

  it('scores only the requested reviewers', () => {
    const set = baseSet();
    set.reviewers.push({ id: 'pm-b', role: 'pm', independentOfPrompt: true });
    set.tickets[0]?.gaps.push({ id: 'g3', reviewerId: 'pm-b', description: 'theirs' });

    const card = scoreRun(set, [run('PAY-142', ['k-real'])], { reviewerIds: ['pm-a'] });
    expect(card.reviewerScope).toEqual(['pm-a']);
    // pm-b's gap is outside scope and must not enter the denominator.
    expect(card.gaps.map((g) => g.gapId)).toEqual(['g1', 'g2']);
  });

  it('rejects an unknown reviewer instead of silently scoring against nobody', () => {
    expect(() => scoreRun(baseSet(), [run('PAY-142', [])], { reviewerIds: ['ghost'] })).toThrow(
      /unknown reviewer/
    );
  });

  it('falls back to all reviewers when none are independent, and says the scope is not independent', () => {
    const set = baseSet();
    set.reviewers = [{ id: 'eng-a', role: 'engineer', independentOfPrompt: false }];
    set.tickets[0] = { externalId: 'PAY-142', gaps: [], verdicts: [] };

    const card = scoreRun(set, [run('PAY-142', ['k-new'])]);
    expect(card.reviewerScope).toEqual(['eng-a']);
    expect(card.independentScope).toBe(false);
  });

  it('breaks results down by category over the shared category list', () => {
    const set = baseSet();
    const card = scoreRun(set, [
      {
        ...run('PAY-142', []),
        flags: [flag('k-real', 'missing_info'), flag('k-noise', 'edge_case')],
      },
    ]);

    const missing = card.byCategory.find((c) => c.category === 'missing_info');
    const edge = card.byCategory.find((c) => c.category === 'edge_case');
    expect(missing).toMatchObject({ produced: 1, real: 1, noise: 0 });
    expect(edge).toMatchObject({ produced: 1, real: 0, noise: 1 });
    // Categories with nothing produced still appear, so a prompt that stopped
    // emitting a whole category is visible as a zero rather than a missing row.
    expect(card.byCategory).toHaveLength(6);
    expect(card.byCategory.find((c) => c.category === 'untestable')?.produced).toBe(0);
  });

  it('computes agreement over flags two reviewers both judged', () => {
    const set = baseSet();
    set.reviewers.push({ id: 'pm-b', role: 'pm', independentOfPrompt: true });
    const verdicts = set.tickets[0]?.verdicts as GoldSet['tickets'][number]['verdicts'];
    verdicts.push(
      {
        dedupeKey: 'k-real',
        verdict: 'real',
        reviewerId: 'pm-b',
        coversGapIds: [],
        label: '',
        note: '',
      },
      {
        dedupeKey: 'k-noise',
        verdict: 'noise',
        reviewerId: 'pm-b',
        coversGapIds: [],
        label: '',
        note: '',
      }
    );

    const card = scoreRun(set, [run('PAY-142', ['k-real', 'k-noise'])]);
    expect(card.agreement).not.toBeNull();
    expect(card.agreement?.items).toBe(2);
    expect(card.agreement?.reviewerPair).toEqual(['pm-a', 'pm-b']);
    expect(card.agreement?.kappa).toBe(1);
  });

  it('reports no agreement figure with a single reviewer', () => {
    expect(scoreRun(baseSet(), [run('PAY-142', ['k-real'])]).agreement).toBeNull();
  });
});

function loaded(set: GoldSet): LoadedGoldSet {
  return { set, ticketsDir: '/tmp/tickets', path: '/tmp/gold-v1.json' };
}

function summary(runs: TicketRun[]): RunSummary {
  return {
    runs,
    promptVersion: 'single-shot-v1@abc123abc123',
    model: 'gpt-4o-mini',
    temperature: 0,
    seed: 1337,
    latencyMsTotal: 4200,
    inputTokens: 1000,
    outputTokens: 500,
  };
}

describe('buildReport', () => {
  it('carries the numbers and the caveats that qualify them', () => {
    const runs = [run('PAY-142', ['k-real', 'k-noise', 'k-new'])];
    const set = baseSet();
    const report = buildReport({
      gold: loaded(set),
      promptName: 'single-shot-v1',
      summary: summary(runs),
      scorecard: scoreRun(set, runs),
      generatedAt: '2026-08-31T00:00:00.000Z',
    });

    expect(report.precision.value).toBe(0.5);
    expect(report.flags.unjudged).toBe(1);
    expect(report.cost.usdPerTicket).toBeCloseTo(0.001, 6);
    expect(report.caveats.join(' ')).toMatch(/no recorded verdict/);
    expect(report.caveats.join(' ')).toMatch(/lower bound/);
  });

  it('omits latency, which would be pure diff noise in a committed file', () => {
    const runs = [run('PAY-142', ['k-real'])];
    const set = baseSet();
    const report = buildReport({
      gold: loaded(set),
      promptName: 'single-shot-v1',
      summary: summary(runs),
      scorecard: scoreRun(set, runs),
      generatedAt: '2026-08-31T00:00:00.000Z',
    });
    expect(JSON.stringify(report)).not.toMatch(/latency/i);
  });

  it('renders without throwing when there is nothing to report', () => {
    const set = baseSet();
    const report = buildReport({
      gold: loaded(set),
      promptName: 'single-shot-v1',
      summary: summary([]),
      scorecard: scoreRun(set, []),
      generatedAt: '2026-08-31T00:00:00.000Z',
    });
    const text = renderReport(report);
    expect(text).toContain('n/a (0 observations)');
    expect(text).toContain('No tickets were analyzed');
  });
});

describe('caveatsFor', () => {
  it('leads with the independence problem, because it invalidates the headline', () => {
    const set = baseSet();
    set.reviewers = [{ id: 'eng-a', role: 'engineer', independentOfPrompt: false }];
    set.tickets[0] = {
      externalId: 'PAY-142',
      gaps: [{ id: 'g1', reviewerId: 'eng-a', description: 'x' }],
      verdicts: [
        {
          dedupeKey: 'k-real',
          verdict: 'real',
          reviewerId: 'eng-a',
          coversGapIds: ['g1'],
          label: '',
          note: '',
        },
      ],
    };

    const caveats = caveatsFor(loaded(set), scoreRun(set, [run('PAY-142', ['k-real'])]));
    expect(caveats[0]).toMatch(/saw the prompt/);
  });

  it('says so when a truncated ticket is in the mix', () => {
    const set = baseSet();
    const runs = [run('PAY-142', ['k-real'], { truncated: true, unverifiedSpans: 2 })];
    const caveats = caveatsFor(loaded(set), scoreRun(set, runs)).join(' ');
    expect(caveats).toMatch(/truncated/);
    expect(caveats).toMatch(/did not occur in the ticket text/);
  });

  it('warns when an unfrozen gold set could be moving under the metric', () => {
    const set = baseSet();
    set.frozen = false;
    const caveats = caveatsFor(loaded(set), scoreRun(set, [run('PAY-142', ['k-real'])])).join(' ');
    expect(caveats).toMatch(/not frozen/);
  });
});

describe('diffReports', () => {
  const make = (precision: [number, number], recall: [number, number], flags: number) => {
    const set = baseSet();
    const runs = [run('PAY-142', [])];
    const report = buildReport({
      gold: loaded(set),
      promptName: 'p',
      summary: summary(runs),
      scorecard: scoreRun(set, runs),
      generatedAt: '2026-08-31T00:00:00.000Z',
    });
    // Overwrite the rates directly: this test is about the diff logic, not scoring.
    return {
      ...report,
      precision: {
        ...report.precision,
        numerator: precision[0],
        denominator: precision[1],
        value: precision[0] / precision[1],
        lower: 0.7,
        upper: 0.99,
      },
      recall: {
        ...report.recall,
        numerator: recall[0],
        denominator: recall[1],
        value: recall[0] / recall[1],
        lower: 0.4,
        upper: 0.9,
      },
      flags: { ...report.flags, produced: flags },
    };
  };

  it('does not call a dip inside the previous interval a regression', () => {
    const previous = make([90, 100], [70, 100], 100);
    const next = { ...previous, precision: { ...previous.precision, value: 0.85 } };
    const diff = diffReports(previous, next);
    expect(diff.precisionDelta).toBeCloseTo(-0.05, 6);
    // 0.85 is above the previous lower bound of 0.70 — noise, not a regression.
    expect(diff.precisionRegressed).toBe(false);
  });

  it('calls a drop below the previous lower bound a regression', () => {
    const previous = make([90, 100], [70, 100], 100);
    const next = { ...previous, precision: { ...previous.precision, value: 0.55 } };
    expect(diffReports(previous, next).precisionRegressed).toBe(true);
  });

  it('notes when the comparison is not apples to apples', () => {
    const previous = make([90, 100], [70, 100], 100);
    const next = {
      ...previous,
      goldSet: { ...previous.goldSet, version: 'gold-v2' },
      model: { ...previous.model, id: 'gpt-4o' },
    };
    const notes = diffReports(previous, next).notes.join(' ');
    expect(notes).toMatch(/Gold set changed/);
    expect(notes).toMatch(/Model changed/);
  });
});

describe('reportPath', () => {
  it('is stable per gold set and prompt, so a re-run shows up as a diff', () => {
    expect(reportPath('/runs', 'gold-v1', 'single-shot-v1')).toMatch(
      /gold-v1__single-shot-v1\.json$/
    );
  });
});
