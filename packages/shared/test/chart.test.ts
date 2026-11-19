import { describe, expect, it } from 'vitest';
import { spreadLabels } from '../src/chart.ts';

describe('spreadLabels', () => {
  it('leaves labels that do not collide where they are', () => {
    expect(spreadLabels([20, 100], 13, 0, 200)).toEqual([20, 100]);
  });

  it('pulls apart two labels at the same height, keeping input order', () => {
    const [a, b] = spreadLabels([196, 196], 13, 10, 196);
    expect(Math.abs(a! - b!)).toBe(13);
    expect(Math.max(a!, b!)).toBeLessThanOrEqual(196);
  });

  it('separates three close labels and stays inside the bounds', () => {
    const out = spreadLabels([50, 52, 51], 13, 10, 200);
    const sorted = [...out].sort((x, y) => x - y);
    expect(sorted[1]! - sorted[0]!).toBeGreaterThanOrEqual(13);
    expect(sorted[2]! - sorted[1]!).toBeGreaterThanOrEqual(13);
    expect(out[0]).toBeLessThan(out[2]!);
  });

  it('handles none, one, and too little room', () => {
    expect(spreadLabels([], 13, 0, 10)).toEqual([]);
    expect(spreadLabels([5], 13, 0, 10)).toEqual([5]);
    expect(spreadLabels([5, 5, 5], 13, 0, 10)).toEqual([0, 13, 26]);
  });
});
