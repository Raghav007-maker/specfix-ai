/**
 * Precision and recall, with honest uncertainty.
 *
 * Two things this module refuses to do, both deliberate:
 *
 *  1. It never reports a bare point estimate. Every rate comes with the counts it
 *     was computed from and a Wilson interval. "Precision 0.83" over 6 flags and
 *     over 600 flags are different claims and must not look the same in a report.
 *
 *  2. It never guesses whether a model flag and a reviewer's gap are the same
 *     thing. That judgment is a human click, recorded in the gold set. Flags with
 *     no recorded verdict are counted as unjudged and excluded from the rate —
 *     they are not silently treated as false positives.
 */

/** 1.96 → 95% confidence. */
const Z = 1.959963984540054;

export interface Rate {
  numerator: number;
  denominator: number;
  /** Null when the denominator is zero — an undefined rate, not zero. */
  value: number | null;
  lower: number | null;
  upper: number | null;
}

/**
 * Wilson score interval. Chosen over the normal approximation because it stays
 * inside [0,1] and behaves at small n, which is exactly the regime a 20-30 ticket
 * gate operates in.
 */
export function rate(numerator: number, denominator: number): Rate {
  if (!Number.isInteger(numerator) || !Number.isInteger(denominator)) {
    throw new Error('rate() takes counts, not fractions');
  }
  if (numerator < 0 || denominator < 0 || numerator > denominator) {
    throw new Error(`nonsensical rate: ${numerator}/${denominator}`);
  }
  if (denominator === 0) {
    return { numerator, denominator, value: null, lower: null, upper: null };
  }

  const p = numerator / denominator;
  const n = denominator;
  const z2 = Z * Z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (Z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));

  return {
    numerator,
    denominator,
    value: p,
    lower: Math.max(0, center - margin),
    upper: Math.min(1, center + margin),
  };
}

export function formatRate(r: Rate): string {
  if (r.value === null) return `n/a (0 observations)`;
  const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
  return `${pct(r.value)} [${pct(r.lower ?? 0)}–${pct(r.upper ?? 1)}]  (${r.numerator}/${r.denominator})`;
}

/**
 * Inter-rater agreement on flag verdicts: Cohen's kappa plus raw agreement.
 *
 * Raw agreement alone is misleading when one verdict dominates — two reviewers who
 * both mark almost everything "real" agree 90% of the time by accident. Kappa
 * corrects for that. Reported together because kappa is unstable at small n and
 * raw agreement is the number people actually understand.
 */
export interface Agreement {
  items: number;
  agreed: number;
  rawAgreement: number | null;
  kappa: number | null;
}

export function agreementOnVerdicts(pairs: readonly [boolean, boolean][]): Agreement {
  const items = pairs.length;
  if (items === 0) {
    return { items: 0, agreed: 0, rawAgreement: null, kappa: null };
  }

  let bothTrue = 0;
  let bothFalse = 0;
  let aTrue = 0;
  let bTrue = 0;

  for (const [a, b] of pairs) {
    if (a) aTrue += 1;
    if (b) bTrue += 1;
    if (a && b) bothTrue += 1;
    if (!a && !b) bothFalse += 1;
  }

  const agreed = bothTrue + bothFalse;
  const observed = agreed / items;

  const pA = aTrue / items;
  const pB = bTrue / items;
  const expected = pA * pB + (1 - pA) * (1 - pB);

  // Both reviewers gave a single verdict to everything: agreement is total but
  // kappa is undefined (0/0), not 1. Say so rather than inventing a number.
  const kappa = expected === 1 ? null : (observed - expected) / (1 - expected);

  return { items, agreed, rawAgreement: observed, kappa };
}
