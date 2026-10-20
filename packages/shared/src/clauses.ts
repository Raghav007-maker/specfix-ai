/**
 * Acceptance-criteria clauses: the unit coverage is measured in.
 *
 * Plan §6 defines AC coverage as "share of approved AC clauses with ≥1 accepted
 * scenario". Two places compute it — the generation eval (`packages/eval`) and the Specs
 * tab's coverage view — and they must agree on what a clause is and what covers it, or
 * the dashboard and the committed eval report would quietly measure different things.
 * Both use these functions.
 */

/**
 * Split acceptance-criteria text into clauses — one per bullet or non-empty line. Bullet
 * markers (`-`, `*`, `1.`) are stripped so a clause matches a scenario's `covers_ac`
 * regardless of list formatting.
 */
export function splitAcClauses(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s+/, '').trim())
    .filter((line) => line.length > 0);
}

/** Collapse whitespace and lowercase, so cover/clause overlap is not defeated by layout. */
export function normalizeClauseText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Whether a scenario's `covers_ac` quote covers a clause: the clause contains the cover,
 * or the cover contains the clause, after normalization — so a scenario that quotes part
 * of a clause still credits that clause. This is the exact (lexical) signal; the
 * embedding-based one only ever adds a suggestion beside it, never replaces it.
 */
export function coverMatchesClause(cover: string, clause: string): boolean {
  const normalizedCover = normalizeClauseText(cover);
  const normalizedClause = normalizeClauseText(clause);
  if (normalizedCover.length === 0 || normalizedClause.length === 0) return false;
  return normalizedClause.includes(normalizedCover) || normalizedCover.includes(normalizedClause);
}

// ---------------------------------------------------------------------------
// Clause coverage for the Specs tab
//
// Exact first, fuzzy second. A clause is *covered* only when an accepted scenario's
// `covers_ac` overlaps it — the eval's rule, and the only status the coverage number
// counts. Embedding similarity never upgrades a clause to covered; it adds a suggestion
// ("likely covered by …") for a reviewer to confirm, because a cosine score is
// evidence, not a reviewed link.
//
// The thresholds are cosine similarities for text-embedding-3-small. They are starting
// values chosen by inspection, not calibrated against labelled pairs — treat a change
// to them as a product decision, and calibrate before quoting any number built on them.
// ---------------------------------------------------------------------------

/** At or above: shown as "likely covered". */
export const SEMANTIC_LIKELY_THRESHOLD = 0.6;
/** At or above (and below likely): shown as "possible match". Below: no suggestion. */
export const SEMANTIC_POSSIBLE_THRESHOLD = 0.45;

export type ClauseCoverageStatus = 'covered' | 'likely' | 'possible' | 'uncovered';

export interface ClauseCoverageRow {
  index: number;
  clause: string;
  status: ClauseCoverageStatus;
  /** The covering scenario (exact) or the suggested one (likely/possible). */
  scenario: { id: string; title: string } | null;
  /** Cosine similarity of the suggestion, when one was computed. */
  similarity: number | null;
}

export interface AcceptedScenarioCover {
  id: string;
  title: string;
  coversAc: string;
}

/** A stored clause vector's best match, as the repository returns it. */
export interface SemanticClauseMatch {
  clauseIndex: number;
  content: string;
  scenarioId: string | null;
  scenarioTitle: string | null;
  similarity: number | null;
}

/**
 * One row per AC clause. `semantic` is null when no clause vectors are available; a
 * semantic row only applies to a clause whose stored text equals the clause as split
 * now, so a vector from a different split can never describe the wrong clause.
 */
export function buildClauseCoverage(
  acceptanceCriteriaText: string,
  accepted: readonly AcceptedScenarioCover[],
  semantic: readonly SemanticClauseMatch[] | null
): ClauseCoverageRow[] {
  const byIndex = new Map((semantic ?? []).map((match) => [match.clauseIndex, match]));

  return splitAcClauses(acceptanceCriteriaText).map((clause, index) => {
    const exact = accepted.find((scenario) => coverMatchesClause(scenario.coversAc, clause));
    if (exact) {
      return {
        index,
        clause,
        status: 'covered',
        scenario: { id: exact.id, title: exact.title },
        similarity: null,
      };
    }

    const match = byIndex.get(index);
    const usable =
      match && match.content === clause && match.scenarioId !== null && match.similarity !== null;
    if (usable && match.similarity !== null && match.scenarioId !== null) {
      const status: ClauseCoverageStatus =
        match.similarity >= SEMANTIC_LIKELY_THRESHOLD
          ? 'likely'
          : match.similarity >= SEMANTIC_POSSIBLE_THRESHOLD
            ? 'possible'
            : 'uncovered';
      return {
        index,
        clause,
        status,
        scenario:
          status === 'uncovered'
            ? null
            : { id: match.scenarioId, title: match.scenarioTitle ?? 'Untitled scenario' },
        similarity: match.similarity,
      };
    }

    return { index, clause, status: 'uncovered', scenario: null, similarity: null };
  });
}

export type DriftVerdict = 'likely_holds' | 'suspect' | 'unknown';

/**
 * For a previously accepted scenario that went stale: does the new version still have
 * a clause close to it? `unknown` when either side has no vector to compare.
 */
export function driftVerdict(similarity: number | null): DriftVerdict {
  if (similarity === null) return 'unknown';
  return similarity >= SEMANTIC_LIKELY_THRESHOLD ? 'likely_holds' : 'suspect';
}
