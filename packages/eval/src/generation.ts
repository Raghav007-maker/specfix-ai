/**
 * Generation-quality metrics (Phase 2, plan §6).
 *
 * These are the measures a scenario/scaffold feature ships with, and they are pure
 * functions over counts and text so they can be unit-tested offline — the same
 * discipline as `metrics.ts`, which they build on by reusing `rate` (so every figure
 * carries its counts and a Wilson interval rather than a bare point estimate).
 *
 * Each metric guards a specific way the numbers could lie:
 *
 *  - Acceptance rate is split into accepted-as-is vs accepted-after-edit, because a
 *    scenario a human rewrote heavily is not a win. `cleanAcceptanceRate` is the
 *    honest headline; the overall rate alone would let heavy edits masquerade as
 *    model quality — the same "real by construction" trap `flags.origin` guards.
 *  - Hallucinated-cover rate is the precision-like signal: a scenario whose `covers_ac`
 *    did not occur verbatim in the acceptance criteria is quoting something the source
 *    does not contain, detected by the same span-verification used for flags.
 *  - AC coverage is the recall-like signal: how many approved AC clauses have at least
 *    one accepted scenario.
 *  - Scaffold validity should be ~100% for a deterministic emitter; the metric exists
 *    to catch a regression that makes it emit something that would not parse.
 */
import { coverMatchesClause, normalizeClauseText } from '@specfix/shared';
import { rate, type Rate } from './metrics.ts';

/**
 * Levenshtein edit distance between two strings. Used to measure how far a reviewer
 * had to rewrite a scenario: a large distance on an "accepted" scenario means the human
 * did the work, not the model.
 */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Two rolling rows rather than the full matrix: O(min) memory.
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  let current = new Array<number>(b.length + 1).fill(0);

  for (let i = 0; i < a.length; i += 1) {
    current[0] = i + 1;
    for (let j = 0; j < b.length; j += 1) {
      const cost = a[i] === b[j] ? 0 : 1;
      current[j + 1] = Math.min(
        (current[j] as number) + 1, // insertion
        (previous[j + 1] as number) + 1, // deletion
        (previous[j] as number) + cost // substitution
      );
    }
    [previous, current] = [current, previous];
  }

  return previous[b.length] as number;
}

/** Edit distance normalized to [0,1] by the longer string. 0 = identical, 1 = disjoint. */
export function normalizedEditDistance(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 0;
  return editDistance(a, b) / longest;
}

export interface AcceptanceInput {
  /** Scenarios the reviewer approved without changing the wording. */
  acceptedAsIs: number;
  /** Scenarios the reviewer accepted only after editing them. */
  acceptedAfterEdit: number;
  /** Scenarios the reviewer dismissed as not useful. */
  dismissed: number;
}

export interface AcceptanceReport {
  reviewed: number;
  /** (acceptedAsIs + acceptedAfterEdit) / reviewed. */
  acceptanceRate: Rate;
  /** acceptedAsIs / reviewed — the honest headline, excluding heavily-rewritten wins. */
  cleanAcceptanceRate: Rate;
  /** acceptedAfterEdit / reviewed — how often an accept required a rewrite. */
  editRate: Rate;
}

/**
 * Scenario acceptance, split so a rewrite cannot pass as a clean win. Draft (undecided)
 * scenarios are not part of the denominator — only reviewed ones are evidence either
 * way, exactly as flag precision counts only reviewed flags.
 */
export function scenarioAcceptance(input: AcceptanceInput): AcceptanceReport {
  const reviewed = input.acceptedAsIs + input.acceptedAfterEdit + input.dismissed;
  const accepted = input.acceptedAsIs + input.acceptedAfterEdit;
  return {
    reviewed,
    acceptanceRate: rate(accepted, reviewed),
    cleanAcceptanceRate: rate(input.acceptedAsIs, reviewed),
    editRate: rate(input.acceptedAfterEdit, reviewed),
  };
}

/**
 * AC coverage (recall-like): the share of acceptance-criteria clauses that at least one
 * accepted scenario covers. A clause counts as covered when an accepted scenario's
 * `covers_ac` string overlaps it in either direction (the clause contains the cover, or
 * the cover contains the clause), after whitespace normalization — so a scenario that
 * quotes part of a clause still credits that clause.
 *
 * The overlap rule is `coverMatchesClause` from @specfix/shared, the same one the Specs
 * tab's coverage view uses, so the dashboard and this report measure the same thing.
 */
export function acCoverage(clauses: readonly string[], acceptedCovers: readonly string[]): Rate {
  const scored = clauses.filter((clause) => normalizeClauseText(clause).length > 0);
  const covered = scored.filter((clause) =>
    acceptedCovers.some((cover) => coverMatchesClause(cover, clause))
  ).length;
  return rate(covered, scored.length);
}

/**
 * Hallucinated-cover rate (precision-like): the share of produced scenarios whose
 * `covers_ac` did not occur in the acceptance criteria and was cleared by the compiler.
 * `unverified` is the compiler's own count, so this never second-guesses the span check.
 */
export function hallucinatedCoverRate(produced: number, unverified: number): Rate {
  return rate(unverified, produced);
}

/**
 * Share of emitted scaffolds whose code is structurally valid. A deterministic emitter
 * should score 1.0; a drop is a regression. Validity here is a cheap structural proxy
 * (balanced delimiters + the expected Playwright anchors), not a full TypeScript
 * compile — that heavier check belongs to a dedicated job, not this pooled metric.
 */
export function scaffoldValidityRate(codes: readonly string[]): Rate {
  const valid = codes.filter((code) => isStructurallyValid(code)).length;
  return rate(valid, codes.length);
}

export function isStructurallyValid(code: string): boolean {
  return (
    balanced(code, '{', '}') &&
    balanced(code, '(', ')') &&
    // `expect` is imported only when used (scaffolds emitted before it were always
    // `{ test, expect }`), so either import line counts.
    /^import \{ test(, expect)? \} from '@playwright\/test';$/m.test(code) &&
    code.includes('test.describe(') &&
    code.includes('test.fixme(')
  );
}

function balanced(code: string, open: string, close: string): boolean {
  let depth = 0;
  for (const ch of code) {
    if (ch === open) depth += 1;
    else if (ch === close) depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0;
}
