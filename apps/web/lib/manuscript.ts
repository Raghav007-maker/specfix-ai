import { splitAcClauses } from '@specfix/shared';

/** A run of ticket text, optionally the quoted span of one flag. */
export interface Segment {
  text: string;
  flagId?: string;
}

export interface Manuscript {
  description: Segment[];
  clauses: Segment[][];
  /** Flags whose quoted span was found verbatim, so the UI can link to it. */
  located: Set<string>;
}

/**
 * Lay out a ticket version for reading, marking each flag's quoted span where it appears.
 *
 * Matching is exact and first-occurrence only: a span the model paraphrased, or one that
 * crosses an AC line break, is simply not marked (the flag still shows the quote itself).
 * This is display only — it never changes what a flag is or what it is keyed to.
 */
export function buildManuscript(
  descriptionText: string,
  acceptanceCriteriaText: string,
  spans: Array<{ flagId: string; quotedSpan: string }>
): Manuscript {
  const located = new Set<string>();
  const blocks = [descriptionText, ...splitAcClauses(acceptanceCriteriaText)];
  const marked = blocks.map((block) => {
    const pending = spans.filter((s) => !located.has(s.flagId) && s.quotedSpan.trim() !== '');
    const segments = markBlock(block, pending);
    for (const seg of segments) if (seg.flagId) located.add(seg.flagId);
    return segments;
  });

  return { description: marked[0] ?? [], clauses: marked.slice(1), located };
}

function markBlock(text: string, spans: Array<{ flagId: string; quotedSpan: string }>): Segment[] {
  const hits = spans
    .map((s) => ({ ...s, start: text.indexOf(s.quotedSpan.trim()) }))
    .filter((h) => h.start >= 0)
    .map((h) => ({ ...h, end: h.start + h.quotedSpan.trim().length }))
    .sort((a, b) => a.start - b.start || b.end - a.end);

  const segments: Segment[] = [];
  let cursor = 0;
  for (const hit of hits) {
    if (hit.start < cursor) continue; // overlaps an earlier mark; leave it unmarked
    if (hit.start > cursor) segments.push({ text: text.slice(cursor, hit.start) });
    segments.push({ text: text.slice(hit.start, hit.end), flagId: hit.flagId });
    cursor = hit.end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor) });
  return segments;
}
