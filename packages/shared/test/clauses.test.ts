/**
 * Clause coverage rules, shared by the generation eval and the Specs coverage view.
 *
 * The property that matters most: embedding similarity can suggest coverage but never
 * produce it. Only an exact `covers_ac` overlap marks a clause covered, so the coverage
 * number cannot be inflated by a loose cosine score.
 */
import { describe, expect, it } from 'vitest';
import {
  SEMANTIC_LIKELY_THRESHOLD,
  SEMANTIC_POSSIBLE_THRESHOLD,
  buildClauseCoverage,
  coverMatchesClause,
  driftVerdict,
  splitAcClauses,
  type SemanticClauseMatch,
} from '../src/index.ts';

const AC = [
  '- Agent can enter a partial refund amount',
  '- The customer is notified by email',
  '- The refund appears in order history',
].join('\n');

const semantic = (
  clauseIndex: number,
  similarity: number | null,
  overrides: Partial<SemanticClauseMatch> = {}
): SemanticClauseMatch => ({
  clauseIndex,
  content: splitAcClauses(AC)[clauseIndex] ?? '',
  scenarioId: similarity === null ? null : `s${clauseIndex}`,
  scenarioTitle: similarity === null ? null : `Scenario ${clauseIndex}`,
  similarity,
  ...overrides,
});

describe('splitAcClauses', () => {
  it('strips list markers, normalizes line endings and drops blank lines', () => {
    expect(splitAcClauses('- one\r\n\r\n2) two\n  * three  ')).toEqual(['one', 'two', 'three']);
  });
});

describe('coverMatchesClause', () => {
  it('matches a partial quote in either direction, ignoring case and layout', () => {
    expect(coverMatchesClause('customer is   NOTIFIED', 'The customer is notified by email')).toBe(
      true
    );
    expect(
      coverMatchesClause('The customer is notified by email today', 'customer is notified by email')
    ).toBe(true);
  });

  it('does not match unrelated text or empty strings', () => {
    expect(coverMatchesClause('refund appears', 'The customer is notified')).toBe(false);
    expect(coverMatchesClause('', 'The customer is notified')).toBe(false);
    expect(coverMatchesClause('anything', '   ')).toBe(false);
  });
});

describe('buildClauseCoverage', () => {
  it('marks a clause covered only by an exact covers_ac overlap', () => {
    const rows = buildClauseCoverage(
      AC,
      [{ id: 'a', title: 'Notify by email', coversAc: 'customer is notified by email' }],
      null
    );

    expect(rows.map((row) => row.status)).toEqual(['uncovered', 'covered', 'uncovered']);
    expect(rows[1]?.scenario).toEqual({ id: 'a', title: 'Notify by email' });
  });

  it('turns similarity into a suggestion, never into coverage', () => {
    const rows = buildClauseCoverage(
      AC,
      [],
      [
        semantic(0, SEMANTIC_LIKELY_THRESHOLD + 0.1),
        semantic(1, SEMANTIC_POSSIBLE_THRESHOLD + 0.01),
        semantic(2, SEMANTIC_POSSIBLE_THRESHOLD - 0.1),
      ]
    );

    expect(rows.map((row) => row.status)).toEqual(['likely', 'possible', 'uncovered']);
    expect(rows.some((row) => row.status === 'covered')).toBe(false);
    expect(rows[0]?.scenario?.id).toBe('s0');
    // Below the floor there is no suggestion, but the score is still shown.
    expect(rows[2]?.scenario).toBeNull();
    expect(rows[2]?.similarity).toBeCloseTo(SEMANTIC_POSSIBLE_THRESHOLD - 0.1);
  });

  it('lets an exact cover win over any similarity score', () => {
    const rows = buildClauseCoverage(
      AC,
      [{ id: 'exact', title: 'History', coversAc: 'refund appears in order history' }],
      [semantic(2, 0.99, { scenarioId: 'other', scenarioTitle: 'Other' })]
    );
    expect(rows[2]).toMatchObject({
      status: 'covered',
      scenario: { id: 'exact' },
      similarity: null,
    });
  });

  it('ignores a stored clause vector whose text no longer matches the clause', () => {
    const rows = buildClauseCoverage(
      AC,
      [],
      [semantic(0, 0.9, { content: 'text from a different split' })]
    );
    expect(rows[0]).toMatchObject({ status: 'uncovered', scenario: null, similarity: null });
  });

  it('reports no suggestion when no accepted scenario is embedded', () => {
    const rows = buildClauseCoverage(AC, [], [semantic(0, null)]);
    expect(rows[0]).toMatchObject({ status: 'uncovered', similarity: null });
  });

  it('returns nothing for empty acceptance criteria', () => {
    expect(buildClauseCoverage('  \n ', [], null)).toEqual([]);
  });
});

describe('driftVerdict', () => {
  it('says a stale scenario likely still holds only above the likely threshold', () => {
    expect(driftVerdict(SEMANTIC_LIKELY_THRESHOLD)).toBe('likely_holds');
    expect(driftVerdict(SEMANTIC_LIKELY_THRESHOLD - 0.01)).toBe('suspect');
    expect(driftVerdict(null)).toBe('unknown');
  });
});
