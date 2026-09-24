/**
 * The volume-matched random-pruning control.
 *
 * ---------------------------------------------------------------------------
 * THE PROBLEM THIS SOLVES
 *
 * "Precision went up after we added the Critic" is not evidence the Critic works.
 * Pruning raises precision mechanically: discard the doubtful half of any flag list
 * and the remainder scores better. A coin flip achieves it. A shredder achieves it.
 * An objective stated as "the Critic improves precision" is one no result can
 * refute, which makes it not an experiment.
 *
 * So the claim has to be sharper: the Critic removes *the right* flags, not merely
 * some flags. This module tests that claim against the only null hypothesis that
 * makes it falsifiable.
 *
 *   H0: the Critic's choice of which flags to prune is no better than choosing the
 *       same number of flags at random, per ticket.
 *
 * Under H0 we resample: for each ticket, discard `prunedCount` candidates chosen
 * uniformly at random, and recompute pooled precision over the survivors. Repeating
 * that a thousand times gives the distribution of precision the Critic would have
 * produced by luck alone. If the real Critic does not sit in the tail of that
 * distribution, it is not doing judgment — it is doing arithmetic.
 *
 * Volume-matched is the load-bearing word. A control that pruned a different number
 * of flags would compare two things at once and answer neither.
 *
 * Two properties worth stating, because they are why this design was chosen over
 * the alternatives:
 *
 *  - It costs nothing. The resampling runs over verdicts already recorded; there is
 *    no second model, no second labeling pass, no API spend.
 *  - It is valid at small n. A permutation test makes no normality assumption and
 *    needs no minimum sample size, which matters when the gold set is twenty tickets
 *    rather than two thousand. A t-test on twenty tickets would not be.
 * ---------------------------------------------------------------------------
 *
 * Reading the output: a small p with a tiny `lift` is not a result worth reporting.
 * The Critic can be reliably-but-trivially better than chance. Both numbers are
 * returned, and `renderControl` prints both, so neither can be quoted alone.
 */
import type { AnalyzedFlag } from '@specfix/core';
import { indexVerdicts, type GoldSet, type GoldVerdict } from './gold.ts';
import { majorityVerdict, type TicketRun } from './score.ts';

/**
 * Iterations. A thousand puts the resolution of the p-value at 0.001, an order of
 * magnitude finer than the 0.05 threshold it is compared against, and runs in
 * milliseconds. Raising it buys precision in a digit nobody reads.
 */
export const DEFAULT_ITERATIONS = 1000;

/**
 * Fixed so a report is reproducible from its inputs. A p-value that moves when you
 * re-run the same data is a p-value someone will re-roll until they like it.
 */
export const DEFAULT_SEED = 20250901;

/** Committed here, in git, so its timestamp predates any run it judges. */
export const SIGNIFICANCE_THRESHOLD = 0.05;

export interface ControlResult {
  /**
   * False when the Critic pruned nothing, or when no surviving flag was judged. The
   * test is undefined in both cases and no p-value is reported — reporting one would
   * be inventing a result out of an absence of evidence.
   */
  applicable: boolean;
  reason: string;
  /** Precision the Critic actually achieved, over judged survivors. */
  observedPrecision: number | null;
  /** Mean precision of the random-pruning null distribution. */
  nullMeanPrecision: number | null;
  /** The 95th percentile of the null distribution — what luck alone reaches. */
  nullP95Precision: number | null;
  /** observedPrecision − nullMeanPrecision. The effect size; report it beside p. */
  lift: number | null;
  /**
   * One-sided: the share of random prunings that matched or beat the Critic.
   *
   * Computed as (1 + #{null ≥ observed}) / (iterations + 1). The +1 is deliberate:
   * a finite resample can never justify p = 0, and an unadjusted count reports
   * exactly that whenever the Critic happens to top every draw.
   */
  pValue: number | null;
  significant: boolean;
  iterations: number;
  seed: number;
  candidatesTotal: number;
  prunedTotal: number;
  /** Judged flags among the survivors — the denominator behind observedPrecision. */
  judgedSurvivors: number;
  /**
   * Gaps that only a pruned flag covered. The Critic deleted a real find here.
   *
   * This should be zero. It is reported separately from the p-value because it is a
   * different kind of failure: the Critic can beat the control on precision while
   * still costing recall, and that trade is not one this project accepts silently.
   */
  gapsLostToPruning: LostGap[];
}

export interface LostGap {
  externalId: string;
  gapId: string;
  description: string;
  /** dedupeKeys of the pruned flags that covered it, and the Critic's stated reason. */
  prunedBy: { dedupeKey: string; whatUnclear: string }[];
}

export interface ControlOptions {
  iterations?: number;
  seed?: number;
  /** Must match the scope `scoreRun` used, or the two numbers describe different runs. */
  reviewerIds: readonly string[];
}

/**
 * One ticket's candidates split by the Critic's decision.
 *
 * `flags` are the survivors — the same array `scoreRun` scores — and `prunedFlags`
 * are what the Critic removed. Their union is the Extractor's candidate list, which
 * is what gets resampled.
 */
export type DeliberatedRun = TicketRun;

export function runControl(
  set: GoldSet,
  runs: readonly DeliberatedRun[],
  options: ControlOptions
): ControlResult {
  const iterations = options.iterations ?? DEFAULT_ITERATIONS;
  const seed = options.seed ?? DEFAULT_SEED;
  const scope = new Set(options.reviewerIds);
  const verdicts = indexVerdicts(set);

  // Per ticket: the judgment of every candidate, and how many the Critic pruned.
  // Errored tickets are excluded here for the same reason scoreRun excludes them
  // from recall — an API outage is not evidence about the Critic.
  const tickets: TicketJudgments[] = [];
  let candidatesTotal = 0;
  let prunedTotal = 0;

  for (const run of runs) {
    if (run.error) continue;
    const byKey: Map<string, GoldVerdict[]> = verdicts.get(run.externalId) ?? new Map();
    const judge = (flag: AnalyzedFlag): Judgment => {
      const inScope = (byKey.get(flag.dedupeKey) ?? []).filter((v) => scope.has(v.reviewerId));
      const verdict = majorityVerdict(inScope.map((v) => v.verdict));
      return verdict === 'real' ? 'real' : verdict === 'noise' ? 'noise' : 'unjudged';
    };

    const kept = run.flags.map(judge);
    const pruned = (run.prunedFlags ?? []).map(judge);
    if (kept.length + pruned.length === 0) continue;

    tickets.push({ kept, pruned });
    candidatesTotal += kept.length + pruned.length;
    prunedTotal += pruned.length;
  }

  const gapsLostToPruning = findLostGaps(set, runs, scope);

  const observed = pooledPrecision(tickets.map((t) => t.kept));
  const base = {
    iterations,
    seed,
    candidatesTotal,
    prunedTotal,
    judgedSurvivors: observed.judged,
    gapsLostToPruning,
  };

  if (prunedTotal === 0) {
    return {
      ...base,
      applicable: false,
      reason: 'the Critic pruned nothing, so there is no pruning decision to test against chance',
      observedPrecision: observed.judged === 0 ? null : observed.precision,
      nullMeanPrecision: null,
      nullP95Precision: null,
      lift: null,
      pValue: null,
      significant: false,
    };
  }

  if (observed.judged === 0) {
    return {
      ...base,
      applicable: false,
      reason: 'no surviving flag has a reviewer verdict yet, so precision is undefined',
      observedPrecision: null,
      nullMeanPrecision: null,
      nullP95Precision: null,
      lift: null,
      pValue: null,
      significant: false,
    };
  }

  const random = mulberry32(seed);
  const nulls = new Float64Array(iterations);
  let atLeastAsGood = 0;

  for (let i = 0; i < iterations; i += 1) {
    const survivors = tickets.map((t) => resample(t, random));
    const { precision, judged } = pooledPrecision(survivors);
    // An iteration whose survivors happen to be entirely unjudged has no precision.
    // Scoring it as zero would flatter the Critic; it is dropped from the comparison
    // and left at the observed value so it can neither help nor hurt.
    nulls[i] = judged === 0 ? observed.precision : precision;
    if ((nulls[i] as number) >= observed.precision) atLeastAsGood += 1;
  }

  const sorted = Array.from(nulls).sort((a, b) => a - b);
  const nullMean = sorted.reduce((total, v) => total + v, 0) / iterations;
  const pValue = (1 + atLeastAsGood) / (iterations + 1);

  return {
    ...base,
    applicable: true,
    reason: '',
    observedPrecision: observed.precision,
    nullMeanPrecision: nullMean,
    nullP95Precision: percentile(sorted, 0.95),
    lift: observed.precision - nullMean,
    pValue,
    significant: pValue < SIGNIFICANCE_THRESHOLD,
  };
}

type Judgment = 'real' | 'noise' | 'unjudged';

interface TicketJudgments {
  kept: Judgment[];
  pruned: Judgment[];
}

/**
 * One draw from the null: keep `kept.length` candidates chosen uniformly from all of
 * them, which is the same as discarding `pruned.length` at random.
 *
 * A partial Fisher–Yates over an index array, so the draw is without replacement and
 * costs O(k) rather than O(n log n).
 */
function resample(ticket: TicketJudgments, random: () => number): Judgment[] {
  const all = [...ticket.kept, ...ticket.pruned];
  const keepCount = ticket.kept.length;
  if (keepCount === all.length) return all;
  if (keepCount === 0) return [];

  const indices = all.map((_, i) => i);
  for (let i = 0; i < keepCount; i += 1) {
    const j = i + Math.floor(random() * (indices.length - i));
    const swap = indices[i] as number;
    indices[i] = indices[j] as number;
    indices[j] = swap;
  }
  return indices.slice(0, keepCount).map((i) => all[i] as Judgment);
}

function pooledPrecision(perTicket: readonly Judgment[][]): { precision: number; judged: number } {
  let real = 0;
  let judged = 0;
  for (const judgments of perTicket) {
    for (const judgment of judgments) {
      if (judgment === 'real') {
        real += 1;
        judged += 1;
      } else if (judgment === 'noise') {
        judged += 1;
      }
    }
  }
  return { precision: judged === 0 ? 0 : real / judged, judged };
}

/**
 * Gaps whose only coverage came from a flag the Critic pruned.
 *
 * A gap covered by both a kept and a pruned flag is not lost — the reviewer still
 * gets asked about it. Only a gap with no surviving cover counts, which is why this
 * takes the whole run rather than the pruned list alone.
 */
function findLostGaps(
  set: GoldSet,
  runs: readonly DeliberatedRun[],
  scope: ReadonlySet<string>
): LostGap[] {
  const runByTicket = new Map(runs.map((r) => [r.externalId, r]));
  const lost: LostGap[] = [];

  for (const ticket of set.tickets) {
    const run = runByTicket.get(ticket.externalId);
    if (!run || run.error) continue;

    const pruned = run.prunedFlags ?? [];
    if (pruned.length === 0) continue;

    const inScope = ticket.verdicts.filter((v) => scope.has(v.reviewerId) && v.verdict === 'real');
    const keptKeys = new Set(run.flags.map((f) => f.dedupeKey));
    const prunedByKey = new Map(pruned.map((f) => [f.dedupeKey, f]));

    for (const gap of ticket.gaps) {
      if (!scope.has(gap.reviewerId)) continue;

      const covering = inScope.filter((v) => v.coversGapIds.includes(gap.id));
      if (covering.length === 0) continue;
      if (covering.some((v) => keptKeys.has(v.dedupeKey))) continue;

      const prunedBy = covering
        .map((v) => prunedByKey.get(v.dedupeKey))
        .filter((f): f is AnalyzedFlag => f !== undefined)
        .map((f) => ({ dedupeKey: f.dedupeKey, whatUnclear: f.what_unclear }));

      // Every covering flag was neither kept nor pruned: it simply was not produced
      // on this run, which is an extraction miss and not the Critic's doing.
      if (prunedBy.length === 0) continue;

      lost.push({
        externalId: ticket.externalId,
        gapId: gap.id,
        description: gap.description,
        prunedBy,
      });
    }
  }

  return lost;
}

function percentile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index] as number;
}

/**
 * mulberry32. Chosen because it is thirty characters of arithmetic with no
 * dependency and no platform variation — the same seed yields the same p-value on
 * every machine that runs the report, which is the only property this needs.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
