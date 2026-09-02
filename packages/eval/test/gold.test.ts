import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import {
  findInconsistencies,
  loadGoldSet,
  indexVerdicts,
  independentReviewers,
  type GoldSet,
} from '../src/gold.ts';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');

function goldSet(overrides: Partial<GoldSet> = {}): GoldSet {
  return {
    version: 'gold-v1',
    frozen: true,
    frozenAt: '2026-08-31',
    ticketsDir: '../tickets/sample',
    notes: '',
    reviewers: [
      { id: 'pm-a', role: 'pm', independentOfPrompt: true },
      { id: 'eng-b', role: 'engineer', independentOfPrompt: false },
    ],
    tickets: [],
    ...overrides,
  };
}

describe('the committed gold-v1 set', () => {
  it('loads and satisfies every structural invariant', async () => {
    const gold = await loadGoldSet(resolve(REPO_ROOT, 'fixtures/gold/gold-v1.json'));
    expect(gold.set.version).toBe('gold-v1');
    expect(findInconsistencies(gold.set)).toEqual([]);
  });

  it('names at least the ten tickets the eval acceptance criterion requires', async () => {
    const gold = await loadGoldSet(resolve(REPO_ROOT, 'fixtures/gold/gold-v1.json'));
    expect(gold.set.tickets.length).toBeGreaterThanOrEqual(10);
  });

  it('resolves its ticket directory relative to the gold file, not the cwd', async () => {
    const gold = await loadGoldSet(resolve(REPO_ROOT, 'fixtures/gold/gold-v1.json'));
    expect(gold.ticketsDir).toBe(resolve(REPO_ROOT, 'fixtures/tickets/sample'));
  });
});

describe('loadGoldSet', () => {
  it('reports the path when the file is missing', async () => {
    await expect(loadGoldSet('does/not/exist.json')).rejects.toThrow(/cannot read gold set/);
  });
});

describe('findInconsistencies', () => {
  it('accepts a well-formed set', () => {
    const problems = findInconsistencies(
      goldSet({
        tickets: [
          {
            externalId: 'PAY-142',
            gaps: [{ id: 'PAY-142-g1', reviewerId: 'pm-a', description: 'no currency stated' }],
            verdicts: [
              {
                dedupeKey: 'missing_info:currency',
                verdict: 'real',
                reviewerId: 'pm-a',
                coversGapIds: ['PAY-142-g1'],
                label: '',
                note: '',
              },
            ],
          },
        ],
      })
    );
    expect(problems).toEqual([]);
  });

  it('rejects a verdict that covers a gap that does not exist', () => {
    // Silently dropping this would inflate nothing and deflate nothing — it would
    // just quietly fail to credit a real catch, which is the hardest kind of bug to
    // notice in a metric.
    const problems = findInconsistencies(
      goldSet({
        tickets: [
          {
            externalId: 'PAY-142',
            gaps: [],
            verdicts: [
              {
                dedupeKey: 'missing_info:currency',
                verdict: 'real',
                reviewerId: 'pm-a',
                coversGapIds: ['PAY-142-g9'],
                label: '',
                note: '',
              },
            ],
          },
        ],
      })
    );
    expect(problems).toEqual([
      'ticket PAY-142: dedupeKey "missing_info:currency" covers unknown gap "PAY-142-g9"',
    ]);
  });

  it('rejects a flag marked noise that also claims to cover a gap', () => {
    const problems = findInconsistencies(
      goldSet({
        tickets: [
          {
            externalId: 'PAY-142',
            gaps: [{ id: 'PAY-142-g1', reviewerId: 'pm-a', description: 'x' }],
            verdicts: [
              {
                dedupeKey: 'edge_case:refund',
                verdict: 'noise',
                reviewerId: 'pm-a',
                coversGapIds: ['PAY-142-g1'],
                label: '',
                note: '',
              },
            ],
          },
        ],
      })
    );
    expect(problems).toContain(
      'ticket PAY-142: dedupeKey "edge_case:refund" is marked noise but covers gaps'
    );
  });

  it('rejects duplicate gap ids, which would double-count the recall denominator', () => {
    const problems = findInconsistencies(
      goldSet({
        tickets: [
          {
            externalId: 'PAY-142',
            gaps: [
              { id: 'PAY-142-g1', reviewerId: 'pm-a', description: 'a' },
              { id: 'PAY-142-g1', reviewerId: 'pm-a', description: 'b' },
            ],
            verdicts: [],
          },
        ],
      })
    );
    expect(problems).toContain('ticket PAY-142: duplicate gap id "PAY-142-g1"');
  });

  it('rejects two verdicts from the same reviewer on the same flag', () => {
    const problems = findInconsistencies(
      goldSet({
        tickets: [
          {
            externalId: 'PAY-142',
            gaps: [],
            verdicts: [
              {
                dedupeKey: 'k',
                verdict: 'real',
                reviewerId: 'pm-a',
                coversGapIds: [],
                label: '',
                note: '',
              },
              {
                dedupeKey: 'k',
                verdict: 'noise',
                reviewerId: 'pm-a',
                coversGapIds: [],
                label: '',
                note: '',
              },
            ],
          },
        ],
      })
    );
    expect(problems).toContain('ticket PAY-142: two verdicts from "pm-a" for dedupeKey "k"');
  });

  it('allows two verdicts on the same flag from different reviewers', () => {
    const problems = findInconsistencies(
      goldSet({
        tickets: [
          {
            externalId: 'PAY-142',
            gaps: [],
            verdicts: [
              {
                dedupeKey: 'k',
                verdict: 'real',
                reviewerId: 'pm-a',
                coversGapIds: [],
                label: '',
                note: '',
              },
              {
                dedupeKey: 'k',
                verdict: 'noise',
                reviewerId: 'eng-b',
                coversGapIds: [],
                label: '',
                note: '',
              },
            ],
          },
        ],
      })
    );
    expect(problems).toEqual([]);
  });

  it('rejects an unknown reviewer id', () => {
    const problems = findInconsistencies(
      goldSet({
        tickets: [
          {
            externalId: 'PAY-142',
            gaps: [{ id: 'g1', reviewerId: 'ghost', description: 'x' }],
            verdicts: [],
          },
        ],
      })
    );
    expect(problems).toContain('ticket PAY-142: gap "g1" cites unknown reviewer "ghost"');
  });

  it('rejects the same ticket appearing twice', () => {
    const problems = findInconsistencies(
      goldSet({
        tickets: [
          { externalId: 'PAY-142', gaps: [], verdicts: [] },
          { externalId: 'PAY-142', gaps: [], verdicts: [] },
        ],
      })
    );
    expect(problems).toContain('ticket PAY-142: appears twice');
  });
});

describe('indexVerdicts', () => {
  it('groups verdicts by ticket and dedupe key', () => {
    const index = indexVerdicts(
      goldSet({
        tickets: [
          {
            externalId: 'PAY-142',
            gaps: [],
            verdicts: [
              {
                dedupeKey: 'k',
                verdict: 'real',
                reviewerId: 'pm-a',
                coversGapIds: [],
                label: '',
                note: '',
              },
              {
                dedupeKey: 'k',
                verdict: 'noise',
                reviewerId: 'eng-b',
                coversGapIds: [],
                label: '',
                note: '',
              },
            ],
          },
        ],
      })
    );
    expect(index.get('PAY-142')?.get('k')).toHaveLength(2);
    expect(index.get('PAY-142')?.get('missing')).toBeUndefined();
  });
});

describe('independentReviewers', () => {
  it('excludes anyone who saw the prompt', () => {
    expect(independentReviewers(goldSet()).map((r) => r.id)).toEqual(['pm-a']);
  });
});
