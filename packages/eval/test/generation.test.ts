/**
 * Offline tests for the generation-quality metrics. No API key, no network — these run
 * on every push, like the flag-metric tests, because the point of the metrics is to be
 * trustworthy and that is a property of the code, not the model.
 */
import { describe, it, expect } from 'vitest';
import {
  acCoverage,
  editDistance,
  hallucinatedCoverRate,
  isStructurallyValid,
  normalizedEditDistance,
  scaffoldValidityRate,
  scenarioAcceptance,
} from '../src/generation.ts';

describe('editDistance', () => {
  it('is zero for identical strings and symmetric', () => {
    expect(editDistance('kitten', 'kitten')).toBe(0);
    expect(editDistance('kitten', 'sitting')).toBe(3);
    expect(editDistance('sitting', 'kitten')).toBe(3);
  });

  it('equals the other string length when one side is empty', () => {
    expect(editDistance('', 'abc')).toBe(3);
    expect(editDistance('abc', '')).toBe(3);
  });

  it('normalizes to [0,1]', () => {
    expect(normalizedEditDistance('abc', 'abc')).toBe(0);
    expect(normalizedEditDistance('', '')).toBe(0);
    expect(normalizedEditDistance('abcd', 'xyzw')).toBe(1);
  });
});

describe('scenarioAcceptance', () => {
  it('splits clean acceptance from accept-after-edit', () => {
    const report = scenarioAcceptance({ acceptedAsIs: 6, acceptedAfterEdit: 2, dismissed: 2 });
    expect(report.reviewed).toBe(10);
    expect(report.acceptanceRate.value).toBeCloseTo(0.8);
    // The honest headline excludes the rewritten two.
    expect(report.cleanAcceptanceRate.value).toBeCloseTo(0.6);
    expect(report.editRate.value).toBeCloseTo(0.2);
  });

  it('is undefined, not zero, with nothing reviewed', () => {
    const report = scenarioAcceptance({ acceptedAsIs: 0, acceptedAfterEdit: 0, dismissed: 0 });
    expect(report.reviewed).toBe(0);
    expect(report.acceptanceRate.value).toBeNull();
  });
});

describe('acCoverage', () => {
  const clauses = [
    'Agent can enter a refund amount',
    'The customer is notified',
    'The refund appears in the order history',
  ];

  it('credits a clause when an accepted cover overlaps it', () => {
    const covers = ['Agent can enter a refund amount', 'the customer is notified'];
    const r = acCoverage(clauses, covers);
    expect(r.numerator).toBe(2);
    expect(r.denominator).toBe(3);
  });

  it('credits a clause when the cover is a substring of it', () => {
    const r = acCoverage(clauses, ['refund amount']);
    expect(r.numerator).toBe(1);
  });

  it('ignores empty covers (derived scenarios) rather than crediting everything', () => {
    const r = acCoverage(clauses, ['', '   ']);
    expect(r.numerator).toBe(0);
    expect(r.denominator).toBe(3);
  });
});

describe('hallucinatedCoverRate', () => {
  it('is the share of produced scenarios whose cover was cleared', () => {
    const r = hallucinatedCoverRate(10, 2);
    expect(r.value).toBeCloseTo(0.2);
  });
});

describe('scaffold validity', () => {
  const valid = [
    `import { test, expect } from '@playwright/test';`,
    ``,
    `test.describe('PAY-142', () => {`,
    `  test.fixme('a scenario', async ({ page }) => {`,
    `    await page.locator('PLACEHOLDER_1_X');`,
    `  });`,
    `});`,
    ``,
  ].join('\n');

  it('accepts well-formed Playwright', () => {
    expect(isStructurallyValid(valid)).toBe(true);
  });

  it('accepts the import without expect, as the emitter now writes it', () => {
    const withoutExpect = valid.replace('{ test, expect }', '{ test }');
    expect(isStructurallyValid(withoutExpect)).toBe(true);
  });

  it('rejects unbalanced or anchor-less code', () => {
    expect(isStructurallyValid(valid.replace('});', '}'))).toBe(false);
    expect(isStructurallyValid('const x = 1;')).toBe(false);
  });

  it('pools into a rate', () => {
    const r = scaffoldValidityRate([valid, valid, 'broken']);
    expect(r.numerator).toBe(2);
    expect(r.denominator).toBe(3);
  });
});
