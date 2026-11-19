/**
 * Moves line-end labels apart so none overlaps: each ends up at least `gap` from its
 * neighbours, as close to its own line as it can, and inside [lo, hi] when there is room.
 * Returns the new positions in the input's order.
 */
export function spreadLabels(ys: number[], gap: number, lo: number, hi: number): number[] {
  const order = ys.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y || a.i - b.i);
  for (let k = 1; k < order.length; k++) {
    order[k]!.y = Math.max(order[k]!.y, order[k - 1]!.y + gap);
  }
  const last = order.length - 1;
  if (last >= 0) order[last]!.y = Math.min(order[last]!.y, hi);
  for (let k = last - 1; k >= 0; k--) {
    order[k]!.y = Math.min(order[k]!.y, order[k + 1]!.y - gap);
  }
  if (order.length && order[0]!.y < lo) {
    // Not enough room inside: keep the gaps and start at the top.
    for (let k = 0; k < order.length; k++) order[k]!.y = lo + k * gap;
  }
  const out = new Array<number>(ys.length);
  for (const { y, i } of order) out[i] = y;
  return out;
}
