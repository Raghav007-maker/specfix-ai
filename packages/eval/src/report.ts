/**
 * Report building, rendering, and diffing.
 *
 * Reports are written to a stable path per (gold set, prompt) — `gold-v1__single-shot-v1.json`
 * — and committed. That is what makes a precision regression show up as a diff in a
 * pull request instead of as a number someone remembers differently. Volatile fields
 * (latency, wall clock) are printed to the terminal but kept out of the file, so a
 * diff means the measurement moved, not that the network was slow.
 *
 * `caveats` is not decoration. Anything that weakens the numbers is written into the
 * report itself, because the report is what gets pasted into a status update, and by
 * then the person reading it has no idea how many flags were unjudged.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { formatRate, type Rate } from './metrics.ts';
import type { Scorecard } from './score.ts';
import type { LoadedGoldSet } from './gold.ts';
import type { RunSummary } from './runner.ts';

export const REPORT_SCHEMA_VERSION = 1;

export interface EvalReport {
  schemaVersion: number;
  generatedAt: string;
  goldSet: { version: string; frozen: boolean; tickets: number };
  prompt: { name: string; version: string };
  model: { id: string; temperature: number; seed: number | null };
  reviewerScope: string[];
  independentScope: boolean;
  tickets: { analyzed: number; failed: number };
  flags: {
    produced: number;
    real: number;
    noise: number;
    disputed: number;
    unjudged: number;
    perTicket: number | null;
  };
  precision: Rate;
  recall: Rate;
  gaps: { total: number; covered: number };
  agreement: Scorecard['agreement'];
  byCategory: Scorecard['byCategory'];
  cost: { usd: number; usdPerTicket: number | null; inputTokens: number; outputTokens: number };
  quality: { truncatedTickets: number; unverifiedSpans: number };
  caveats: string[];
  failures: { externalId: string; error: string }[];
}

export interface BuildReportInput {
  gold: LoadedGoldSet;
  promptName: string;
  summary: RunSummary;
  scorecard: Scorecard;
  /** Injected rather than read from the clock, so tests are deterministic. */
  generatedAt: string;
}

export function buildReport(input: BuildReportInput): EvalReport {
  const { gold, summary, scorecard } = input;

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    generatedAt: input.generatedAt,
    goldSet: {
      version: gold.set.version,
      frozen: gold.set.frozen,
      tickets: gold.set.tickets.length,
    },
    prompt: { name: input.promptName, version: summary.promptVersion },
    model: { id: summary.model, temperature: summary.temperature, seed: summary.seed },
    reviewerScope: scorecard.reviewerScope,
    independentScope: scorecard.independentScope,
    tickets: { analyzed: scorecard.ticketsAnalyzed, failed: scorecard.ticketsFailed },
    flags: {
      produced: scorecard.flagsProduced,
      real: scorecard.counts.real,
      noise: scorecard.counts.noise,
      disputed: scorecard.counts.disputed,
      unjudged: scorecard.counts.unjudged,
      perTicket: round(scorecard.flagsPerTicket, 2),
    },
    precision: scorecard.precision,
    recall: scorecard.recall,
    gaps: { total: scorecard.gaps.length, covered: scorecard.gaps.filter((g) => g.covered).length },
    agreement: scorecard.agreement,
    byCategory: scorecard.byCategory,
    cost: {
      usd: round(scorecard.costUsd, 6) ?? 0,
      usdPerTicket:
        scorecard.ticketsAnalyzed === 0
          ? null
          : round(scorecard.costUsd / scorecard.ticketsAnalyzed, 6),
      inputTokens: summary.inputTokens,
      outputTokens: summary.outputTokens,
    },
    quality: {
      truncatedTickets: scorecard.truncatedTickets,
      unverifiedSpans: scorecard.unverifiedSpans,
    },
    caveats: caveatsFor(gold, scorecard),
    failures: summary.runs
      .filter((r) => r.error)
      .map((r) => ({ externalId: r.externalId, error: r.error as string })),
  };
}

/**
 * Every condition here has burned someone's metric before. They are emitted in
 * severity order so the first line of the list is the one that matters most.
 */
export function caveatsFor(gold: LoadedGoldSet, scorecard: Scorecard): string[] {
  const caveats: string[] = [];
  const { counts, precision, recall } = scorecard;

  if (scorecard.ticketsAnalyzed === 0) {
    caveats.push('No tickets were analyzed. Every number below is empty.');
    return caveats;
  }

  if (!scorecard.independentScope) {
    caveats.push(
      'Labels come from a reviewer who saw the prompt. Usable for iteration; not a headline precision claim.'
    );
  }

  if (counts.unjudged > 0) {
    const share = ((counts.unjudged / Math.max(1, scorecard.flagsProduced)) * 100).toFixed(0);
    caveats.push(
      `${counts.unjudged} of ${scorecard.flagsProduced} flags (${share}%) have no recorded verdict. ` +
        'They are excluded from precision, and cannot yet be credited with covering a gap, so recall is a lower bound.'
    );
  }

  if (counts.disputed > 0) {
    caveats.push(
      `${counts.disputed} flag(s) split the reviewers evenly and were excluded from precision.`
    );
  }

  if (precision.denominator > 0 && precision.denominator < 30) {
    caveats.push(
      `Precision rests on ${precision.denominator} judged flags. The interval is wide; do not compare point estimates.`
    );
  }

  if (recall.denominator === 0) {
    caveats.push(
      'No reviewer gaps in scope, so recall is undefined. Run the blind-first labeling flow to populate them.'
    );
  } else if (recall.denominator < 30) {
    caveats.push(
      `Recall rests on ${recall.denominator} reviewer gaps and is correspondingly noisy.`
    );
  }

  if (!gold.set.frozen) {
    caveats.push(
      `${gold.set.version} is not frozen. Labels can still change, so a metric shift may be the answer key moving.`
    );
  }

  if (scorecard.ticketsFailed > 0) {
    caveats.push(
      `${scorecard.ticketsFailed} ticket(s) failed to analyze and were excluded from both precision and recall.`
    );
  }

  if (scorecard.truncatedTickets > 0) {
    caveats.push(
      `${scorecard.truncatedTickets} ticket(s) exceeded the input ceiling and were truncated before analysis.`
    );
  }

  if (scorecard.unverifiedSpans > 0) {
    caveats.push(
      `${scorecard.unverifiedSpans} quoted span(s) did not occur in the ticket text and were cleared.`
    );
  }

  const kappa = scorecard.agreement?.kappa;
  if (kappa !== undefined && kappa !== null && kappa < 0.4) {
    caveats.push(
      `Inter-rater kappa is ${kappa.toFixed(2)}. The reviewers do not agree on what counts as a real flag; fix the rubric before trusting precision.`
    );
  }

  return caveats;
}

export function renderReport(report: EvalReport): string {
  const lines: string[] = [];
  const row = (label: string, value: string): string => `  ${label.padEnd(22)}${value}`;

  lines.push('');
  lines.push(`${report.prompt.version}  ×  ${report.goldSet.version}`);
  lines.push('─'.repeat(72));
  lines.push(
    row(
      'model',
      `${report.model.id}  temp=${report.model.temperature}  seed=${report.model.seed ?? 'none'}`
    )
  );
  lines.push(
    row(
      'reviewers',
      `${report.reviewerScope.join(', ') || 'none'}${report.independentScope ? '' : '  (not independent)'}`
    )
  );
  lines.push(
    row(
      'tickets',
      `${report.tickets.analyzed} analyzed${report.tickets.failed > 0 ? `, ${report.tickets.failed} failed` : ''}`
    )
  );
  lines.push(
    row('flags', `${report.flags.produced} produced, ${report.flags.perTicket ?? '–'}/ticket`)
  );
  lines.push('');
  lines.push(row('precision', formatRate(report.precision)));
  lines.push(row('recall (lower bound)', formatRate(report.recall)));
  lines.push(
    row(
      'verdicts',
      `${report.flags.real} real  ${report.flags.noise} noise  ${report.flags.disputed} disputed  ${report.flags.unjudged} unjudged`
    )
  );
  if (report.agreement) {
    const { kappa, rawAgreement, items, reviewerPair } = report.agreement;
    lines.push(
      row(
        'agreement',
        `κ=${kappa === null ? 'n/a' : kappa.toFixed(2)}  raw=${rawAgreement === null ? 'n/a' : (rawAgreement * 100).toFixed(0) + '%'}  (${items} flags, ${reviewerPair.join(' vs ')})`
      )
    );
  }
  lines.push(
    row(
      'cost',
      `$${report.cost.usd.toFixed(4)} total, $${(report.cost.usdPerTicket ?? 0).toFixed(4)}/ticket  (${report.cost.inputTokens}→${report.cost.outputTokens} tok)`
    )
  );

  lines.push('');
  lines.push('  by category');
  const width = Math.max(...report.byCategory.map((c) => c.category.length));
  for (const c of report.byCategory) {
    const detail =
      c.produced === 0
        ? '–'
        : `${String(c.produced).padStart(3)} produced   ${c.real}/${c.real + c.noise} real   ${c.unjudged} unjudged`;
    lines.push(`    ${c.category.padEnd(width + 2)}${detail}`);
  }

  if (report.failures.length > 0) {
    lines.push('');
    lines.push('  failures');
    for (const failure of report.failures) {
      lines.push(`    ${failure.externalId}: ${failure.error}`);
    }
  }

  if (report.caveats.length > 0) {
    lines.push('');
    lines.push('  caveats');
    for (const caveat of report.caveats) {
      lines.push(`    - ${caveat}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

export function reportPath(runsDir: string, goldVersion: string, promptName: string): string {
  return join(runsDir, `${goldVersion}__${promptName}.json`);
}

export async function writeReport(path: string, report: EvalReport): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

export async function readReport(path: string): Promise<EvalReport | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as EvalReport;
  } catch {
    return undefined;
  }
}

export interface ReportDiff {
  precisionDelta: number | null;
  recallDelta: number | null;
  flagsDelta: number;
  costPerTicketDelta: number | null;
  /**
   * True when the new point estimate falls outside the previous interval — the drop
   * is larger than sampling noise comfortably explains. A small dip inside the
   * interval is not called a regression, because treating every wobble as one
   * teaches people to ignore the check.
   */
  precisionRegressed: boolean;
  recallRegressed: boolean;
  notes: string[];
}

export function diffReports(previous: EvalReport, next: EvalReport): ReportDiff {
  const notes: string[] = [];

  if (previous.goldSet.version !== next.goldSet.version) {
    notes.push(
      `Gold set changed (${previous.goldSet.version} → ${next.goldSet.version}). The comparison is not apples to apples.`
    );
  }
  if (previous.model.id !== next.model.id) {
    notes.push(`Model changed (${previous.model.id} → ${next.model.id}).`);
  }
  if (previous.prompt.version !== next.prompt.version) {
    notes.push(`Prompt changed (${previous.prompt.version} → ${next.prompt.version}).`);
  }
  if (previous.reviewerScope.join(',') !== next.reviewerScope.join(',')) {
    notes.push('Reviewer scope changed, so the labels underneath both numbers differ.');
  }

  const delta = (a: Rate, b: Rate): number | null =>
    a.value === null || b.value === null ? null : b.value - a.value;

  const regressed = (before: Rate, after: Rate): boolean =>
    before.value !== null &&
    after.value !== null &&
    before.lower !== null &&
    after.value < before.lower;

  return {
    precisionDelta: delta(previous.precision, next.precision),
    recallDelta: delta(previous.recall, next.recall),
    flagsDelta: next.flags.produced - previous.flags.produced,
    costPerTicketDelta:
      previous.cost.usdPerTicket === null || next.cost.usdPerTicket === null
        ? null
        : next.cost.usdPerTicket - previous.cost.usdPerTicket,
    precisionRegressed: regressed(previous.precision, next.precision),
    recallRegressed: regressed(previous.recall, next.recall),
    notes,
  };
}

export function renderDiff(diff: ReportDiff): string {
  const pp = (value: number | null): string =>
    value === null ? 'n/a' : `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}pp`;

  const lines = [
    '  vs previous committed report',
    `    precision       ${pp(diff.precisionDelta)}${diff.precisionRegressed ? '   REGRESSION' : ''}`,
    `    recall          ${pp(diff.recallDelta)}${diff.recallRegressed ? '   REGRESSION' : ''}`,
    `    flags produced  ${diff.flagsDelta >= 0 ? '+' : ''}${diff.flagsDelta}`,
    `    cost/ticket     ${
      diff.costPerTicketDelta === null
        ? 'n/a'
        : `${diff.costPerTicketDelta >= 0 ? '+' : ''}$${diff.costPerTicketDelta.toFixed(6)}`
    }`,
  ];

  for (const note of diff.notes) {
    lines.push(`    note: ${note}`);
  }

  return lines.join('\n');
}

function round(value: number | null, places: number): number | null {
  if (value === null) return null;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
