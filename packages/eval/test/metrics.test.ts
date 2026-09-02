import { describe, it, expect } from 'vitest';
import { rate, formatRate, agreementOnVerdicts } from '../src/metrics.ts';

describe('rate', () => {
  it('returns an undefined rate for zero observations, not zero', () => {
    const r = rate(0, 0);
    expect(r.value).toBeNull();
    expect(r.lower).toBeNull();
    expect(formatRate(r)).toContain('n/a');
  });

  it('computes the point estimate', () => {
    expect(rate(3, 4).value).toBe(0.75);
  });

  it('brackets the estimate with a Wilson interval', () => {
    const r = rate(3, 4);
    expect(r.lower).toBeLessThan(0.75);
    expect(r.upper).toBeGreaterThan(0.75);
  });

  it('stays inside [0,1] at the boundaries, where the normal approximation does not', () => {
    const perfect = rate(5, 5);
    expect(perfect.upper).toBe(1);
    expect(perfect.lower).toBeGreaterThan(0);
    expect(perfect.lower).toBeLessThan(1);

    const zero = rate(0, 5);
    expect(zero.lower).toBe(0);
    expect(zero.upper).toBeLessThan(1);
  });

  it('narrows as n grows, which is the whole reason the interval is reported', () => {
    const small = rate(8, 10);
    const large = rate(800, 1000);
    const width = (r: ReturnType<typeof rate>): number => (r.upper ?? 1) - (r.lower ?? 0);
    expect(width(large)).toBeLessThan(width(small));
    // 8/10 is compatible with a coin flip; 800/1000 is not.
    expect(small.lower).toBeLessThan(0.55);
    expect(large.lower).toBeGreaterThan(0.75);
  });

  it('matches the published Wilson interval for 10/20', () => {
    const r = rate(10, 20);
    expect(r.lower).toBeCloseTo(0.2993, 3);
    expect(r.upper).toBeCloseTo(0.7007, 3);
  });

  it('rejects impossible counts instead of returning a number above 1', () => {
    expect(() => rate(5, 4)).toThrow(/nonsensical/);
    expect(() => rate(-1, 4)).toThrow(/nonsensical/);
  });

  it('rejects fractions, which would mean someone averaged before aggregating', () => {
    expect(() => rate(1.5, 4)).toThrow(/counts/);
  });
});

describe('agreementOnVerdicts', () => {
  it('reports nothing for an empty overlap', () => {
    expect(agreementOnVerdicts([])).toEqual({
      items: 0,
      agreed: 0,
      rawAgreement: null,
      kappa: null,
    });
  });

  it('scores perfect agreement as kappa 1 when verdicts are mixed', () => {
    const result = agreementOnVerdicts([
      [true, true],
      [false, false],
      [true, true],
      [false, false],
    ]);
    expect(result.rawAgreement).toBe(1);
    expect(result.kappa).toBe(1);
  });

  it('leaves kappa undefined when both reviewers used one verdict for everything', () => {
    // 100% raw agreement, but no information: kappa is 0/0. Reporting 1.0 here
    // would be the classic way to claim reviewers agree when they never disagreed
    // about anything because they never varied.
    const result = agreementOnVerdicts([
      [true, true],
      [true, true],
      [true, true],
    ]);
    expect(result.rawAgreement).toBe(1);
    expect(result.kappa).toBeNull();
  });

  it('scores chance-level agreement near zero', () => {
    const result = agreementOnVerdicts([
      [true, true],
      [true, false],
      [false, true],
      [false, false],
    ]);
    expect(result.rawAgreement).toBe(0.5);
    expect(result.kappa).toBeCloseTo(0, 6);
  });

  it('penalizes high raw agreement that is mostly chance', () => {
    // Nine "real" verdicts and one disagreement: 90% raw agreement, weak kappa.
    const pairs: [boolean, boolean][] = [
      ...Array.from({ length: 9 }, () => [true, true] as [boolean, boolean]),
      [true, false],
    ];
    const result = agreementOnVerdicts(pairs);
    expect(result.rawAgreement).toBe(0.9);
    expect(result.kappa).not.toBeNull();
    expect(result.kappa as number).toBeLessThan(0.2);
  });
});
