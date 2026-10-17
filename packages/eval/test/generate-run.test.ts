/**
 * Offline tests for the generation-eval aggregation. The runner itself makes API calls,
 * but the clause splitting and report aggregation are pure, so they run here with no key
 * — the numbers a report shows are only trustworthy if the aggregation is.
 */
import { describe, it, expect } from 'vitest';
import {
  buildGenerationReport,
  splitAcClauses,
  type GenerationRunSummary,
} from '../src/generate-run.ts';
import type { LoadedGoldSet } from '../src/gold.ts';

const VALID_SCAFFOLD = [
  `import { test, expect } from '@playwright/test';`,
  ``,
  `test.describe('A', () => {`,
  `  test.fixme('s', async ({ page }) => {`,
  `    await page.locator('PH');`,
  `  });`,
  `});`,
  ``,
].join('\n');

function goldOf(ticketIds: string[]): LoadedGoldSet {
  return {
    set: {
      version: 'gold-v1',
      frozen: true,
      frozenAt: null,
      ticketsDir: 'tickets',
      notes: '',
      reviewers: [{ id: 'r1', role: 'pm', independentOfPrompt: true }],
      tickets: ticketIds.map((externalId) => ({ externalId, gaps: [], verdicts: [] })),
    },
    ticketsDir: '/tmp/tickets',
    path: '/tmp/gold-v1.json',
  };
}

describe('splitAcClauses', () => {
  it('strips bullet and numbered markers and drops blank lines', () => {
    const clauses = splitAcClauses(
      [
        '- Agent can enter an amount',
        '* The customer is notified',
        '',
        '1. It appears in history',
      ].join('\n')
    );
    expect(clauses).toEqual([
      'Agent can enter an amount',
      'The customer is notified',
      'It appears in history',
    ]);
  });

  it('is empty for empty criteria', () => {
    expect(splitAcClauses('')).toEqual([]);
    expect(splitAcClauses('   \n  \n')).toEqual([]);
  });
});

describe('buildGenerationReport', () => {
  it('pools coverage per ticket and aggregates the automatic metrics', () => {
    const summary: GenerationRunSummary = {
      tickets: [
        {
          externalId: 'A',
          acClauses: ['x', 'y'],
          covers: ['x'],
          produced: 2,
          unverifiedCovers: 1,
          scaffoldCodes: [VALID_SCAFFOLD],
          costUsd: 0.001,
          truncated: false,
        },
        {
          externalId: 'B',
          acClauses: ['z'],
          covers: ['z'],
          produced: 1,
          unverifiedCovers: 0,
          scaffoldCodes: ['broken'],
          costUsd: 0.002,
          truncated: false,
        },
      ],
      promptVersion: 'compile-gherkin-v1@abc',
      model: 'gpt-4o-mini',
      temperature: 0,
      seed: null,
      inputTokens: 100,
      outputTokens: 50,
      latencyMsTotal: 1234,
    };

    const report = buildGenerationReport({
      gold: goldOf(['A', 'B']),
      promptName: 'compile-gherkin-v1',
      summary,
      generatedAt: '2026-01-01T00:00:00.000Z',
    });

    expect(report.tickets).toEqual({ analyzed: 2, failed: 0 });
    expect(report.scenarios).toEqual({ produced: 3, perTicket: 1.5 });
    // 'x' covers clause x but not y; 'z' covers z. Pooled: 2 of 3 clauses.
    expect(report.acCoverage.numerator).toBe(2);
    expect(report.acCoverage.denominator).toBe(3);
    // One of three produced scenarios had its cover cleared.
    expect(report.hallucinatedCoverRate.numerator).toBe(1);
    expect(report.hallucinatedCoverRate.denominator).toBe(3);
    // One valid scaffold, one broken.
    expect(report.scaffoldValidity.numerator).toBe(1);
    expect(report.scaffoldValidity.denominator).toBe(2);
    expect(report.cost.usd).toBeCloseTo(0.003);
  });

  it('excludes failed tickets from every metric and records them', () => {
    const summary: GenerationRunSummary = {
      tickets: [
        {
          externalId: 'A',
          acClauses: ['x'],
          covers: ['x'],
          produced: 1,
          unverifiedCovers: 0,
          scaffoldCodes: [VALID_SCAFFOLD],
          costUsd: 0.001,
          truncated: false,
        },
        {
          externalId: 'B',
          acClauses: [],
          covers: [],
          produced: 0,
          unverifiedCovers: 0,
          scaffoldCodes: [],
          costUsd: 0,
          truncated: false,
          error: 'rate limited',
        },
      ],
      promptVersion: 'compile-gherkin-v1@abc',
      model: 'gpt-4o-mini',
      temperature: 0,
      seed: null,
      inputTokens: 10,
      outputTokens: 5,
      latencyMsTotal: 1,
    };

    const report = buildGenerationReport({
      gold: goldOf(['A', 'B']),
      promptName: 'compile-gherkin-v1',
      summary,
      generatedAt: '2026-01-01T00:00:00.000Z',
    });

    expect(report.tickets).toEqual({ analyzed: 1, failed: 1 });
    expect(report.failures).toEqual([{ externalId: 'B', error: 'rate limited' }]);
    expect(report.acCoverage.numerator).toBe(1);
    expect(report.acCoverage.denominator).toBe(1);
    expect(report.caveats.some((c) => c.includes('failed to compile'))).toBe(true);
  });
});
