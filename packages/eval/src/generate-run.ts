/**
 * The generation-eval arm: compile scenarios over a gold set's tickets and score the
 * automatic quality metrics.
 *
 * This is the counterpart of `runner.ts` for Phase 2. The difference is what can be
 * measured without a human: flag precision needs a reviewer's verdict, but three of the
 * generation metrics do not —
 *
 *  - AC coverage: does each acceptance-criteria clause have a scenario whose verified
 *    `covers_ac` overlaps it?
 *  - Hallucinated-cover rate: how many produced scenarios quoted a clause that did not
 *    occur in the criteria (the compiler cleared it)?
 *  - Scaffold validity: does every emitted scaffold parse structurally?
 *
 * Scenario acceptance rate — the one metric that needs a human — is deliberately NOT
 * here; it is measured from production review data (`scenario_reviews`), because an
 * automated run has no reviewer and inventing one would defeat the measurement.
 *
 * The compile and emit steps are pure functions of the ticket, so the aggregation
 * (`buildGenerationReport`) is split out and unit-tested offline; only `runGeneration`
 * makes API calls.
 */
import { compileScenarios, emitPlaywrightScaffold } from '@specfix/compiler';
import { FileSource } from '@specfix/ingest';
import { toAnalyzable, type NormalizedTicket } from '@specfix/shared';
import type { LoadedGoldSet } from './gold.ts';
import { formatRate, rate, type Rate } from './metrics.ts';
import { acCoverage, isStructurallyValid } from './generation.ts';

/** Bumped only when the report shape changes, so an old report is never diffed as new. */
export const GENERATION_REPORT_SCHEMA_VERSION = 1;

export interface GenerationRunOptions {
  gold: LoadedGoldSet;
  promptName: string;
  model?: string | undefined;
  /** Compile only the first N tickets. For smoke runs. */
  limit?: number | undefined;
  concurrency?: number;
  onProgress?: ((event: GenerationProgress) => void) | undefined;
}

export interface GenerationProgress {
  externalId: string;
  index: number;
  total: number;
  scenarioCount: number;
  error?: string;
}

/** One ticket's generation outcome, before aggregation. Exported for tests. */
export interface TicketGeneration {
  externalId: string;
  /** Acceptance-criteria clauses, one per bullet/line. */
  acClauses: string[];
  /** Verified `covers_ac` strings of the produced scenarios. */
  covers: string[];
  produced: number;
  /** Scenarios whose `covers_ac` did not occur in the criteria and was cleared. */
  unverifiedCovers: number;
  /** Emitted scaffold code, one per produced scenario. */
  scaffoldCodes: string[];
  costUsd: number;
  truncated: boolean;
  error?: string;
}

export interface GenerationRunSummary {
  tickets: TicketGeneration[];
  promptVersion: string;
  model: string;
  temperature: number;
  seed: number | null;
  inputTokens: number;
  outputTokens: number;
  latencyMsTotal: number;
}

export interface GenerationReport {
  schemaVersion: number;
  generatedAt: string;
  goldSet: { version: string; frozen: boolean; tickets: number };
  prompt: { name: string; version: string };
  model: { id: string; temperature: number; seed: number | null };
  tickets: { analyzed: number; failed: number };
  scenarios: { produced: number; perTicket: number | null };
  /** Share of AC clauses with at least one covering scenario, pooled across tickets. */
  acCoverage: Rate;
  /** Share of produced scenarios whose cover was cleared as not-in-criteria. */
  hallucinatedCoverRate: Rate;
  /** Share of emitted scaffolds that parse structurally. */
  scaffoldValidity: Rate;
  cost: { usd: number; usdPerTicket: number | null; inputTokens: number; outputTokens: number };
  caveats: string[];
  failures: { externalId: string; error: string }[];
}

export async function runGeneration(options: GenerationRunOptions): Promise<GenerationRunSummary> {
  const { gold, promptName } = options;
  const source = new FileSource({ dir: gold.ticketsDir });
  const available = new Map((await source.list()).map((t) => [t.externalId, t]));

  const wanted = gold.set.tickets.map((t) => t.externalId);
  const missing = wanted.filter((id) => !available.has(id));
  if (missing.length > 0) {
    throw new Error(
      `gold set names ${missing.length} ticket(s) absent from ${gold.ticketsDir}: ${missing.join(', ')}`
    );
  }

  const selected = (options.limit === undefined ? wanted : wanted.slice(0, options.limit)).map(
    (id) => available.get(id) as NormalizedTicket
  );

  const results = new Array<TicketGeneration>(selected.length);
  const meta = {
    promptVersion: '',
    model: options.model ?? '',
    temperature: 0,
    seed: null as number | null,
    inputTokens: 0,
    outputTokens: 0,
    latencyMsTotal: 0,
  };

  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < selected.length) {
      const index = cursor;
      cursor += 1;
      const ticket = selected[index] as NormalizedTicket;
      const analyzable = toAnalyzable(ticket);

      try {
        const outcome = await compileScenarios(
          {
            externalKey: analyzable.externalKey,
            title: analyzable.title,
            acceptanceCriteriaText: analyzable.acceptanceCriteriaText,
            resolvedFlags: [],
          },
          { promptName, ...(options.model === undefined ? {} : { model: options.model }) }
        );

        const scaffoldCodes = outcome.scenarios.map(
          (scenario) =>
            emitPlaywrightScaffold({
              scenario: { title: scenario.title, steps: scenario.steps },
              externalKey: analyzable.externalKey,
              scenarioId: scenario.dedupeKey,
            }).code
        );

        results[index] = {
          externalId: ticket.externalId,
          acClauses: splitAcClauses(analyzable.acceptanceCriteriaText),
          covers: outcome.scenarios.map((s) => s.covers_ac).filter((c) => c.trim().length > 0),
          produced: outcome.scenarios.length,
          unverifiedCovers: outcome.meta.unverifiedAc,
          scaffoldCodes,
          costUsd: outcome.meta.costUsd,
          truncated: outcome.meta.truncated,
        };
        meta.promptVersion = outcome.meta.promptVersion;
        meta.model = outcome.meta.model;
        meta.temperature = outcome.meta.temperature;
        meta.seed = outcome.meta.seed;
        meta.inputTokens += outcome.meta.inputTokens;
        meta.outputTokens += outcome.meta.outputTokens;
        meta.latencyMsTotal += outcome.meta.latencyMs;

        options.onProgress?.({
          externalId: ticket.externalId,
          index: index + 1,
          total: selected.length,
          scenarioCount: outcome.scenarios.length,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results[index] = {
          externalId: ticket.externalId,
          acClauses: [],
          covers: [],
          produced: 0,
          unverifiedCovers: 0,
          scaffoldCodes: [],
          costUsd: 0,
          truncated: false,
          error: message,
        };
        options.onProgress?.({
          externalId: ticket.externalId,
          index: index + 1,
          total: selected.length,
          scenarioCount: 0,
          error: message,
        });
      }
    }
  };

  const lanes = Math.max(1, Math.min(options.concurrency ?? 3, selected.length));
  await Promise.all(Array.from({ length: lanes }, () => worker()));

  return { tickets: results, ...meta };
}

export interface BuildGenerationReportInput {
  gold: LoadedGoldSet;
  promptName: string;
  summary: GenerationRunSummary;
  generatedAt: string;
}

/**
 * Pure aggregation of a run into a report. AC coverage is computed per ticket and the
 * counts pooled, so a cover from one ticket can never be matched against a clause from
 * another — pooling the strings globally would inflate coverage with false matches.
 */
export function buildGenerationReport(input: BuildGenerationReportInput): GenerationReport {
  const { gold, summary } = input;
  const ok = summary.tickets.filter((t) => !t.error);
  const failed = summary.tickets.filter((t) => t.error);

  let coveredClauses = 0;
  let totalClauses = 0;
  let produced = 0;
  let unverified = 0;
  const scaffoldCodes: string[] = [];
  let costUsd = 0;

  for (const ticket of ok) {
    const coverage = acCoverage(ticket.acClauses, ticket.covers);
    coveredClauses += coverage.numerator;
    totalClauses += coverage.denominator;
    produced += ticket.produced;
    unverified += ticket.unverifiedCovers;
    scaffoldCodes.push(...ticket.scaffoldCodes);
    costUsd += ticket.costUsd;
  }

  const validScaffolds = scaffoldCodes.filter((code) => isStructurallyValid(code)).length;

  return {
    schemaVersion: GENERATION_REPORT_SCHEMA_VERSION,
    generatedAt: input.generatedAt,
    goldSet: {
      version: gold.set.version,
      frozen: gold.set.frozen,
      tickets: gold.set.tickets.length,
    },
    prompt: { name: input.promptName, version: summary.promptVersion },
    model: { id: summary.model, temperature: summary.temperature, seed: summary.seed },
    tickets: { analyzed: ok.length, failed: failed.length },
    scenarios: { produced, perTicket: ok.length === 0 ? null : round(produced / ok.length, 2) },
    acCoverage: rate(coveredClauses, totalClauses),
    hallucinatedCoverRate: rate(unverified, produced),
    scaffoldValidity: rate(validScaffolds, scaffoldCodes.length),
    cost: {
      usd: round(costUsd, 6) ?? 0,
      usdPerTicket: ok.length === 0 ? null : round(costUsd / ok.length, 6),
      inputTokens: summary.inputTokens,
      outputTokens: summary.outputTokens,
    },
    caveats: generationCaveats(gold, ok.length, failed.length, totalClauses),
    failures: failed.map((t) => ({ externalId: t.externalId, error: t.error as string })),
  };
}

function generationCaveats(
  gold: LoadedGoldSet,
  analyzed: number,
  failedCount: number,
  totalClauses: number
): string[] {
  const caveats: string[] = [];
  if (analyzed === 0) {
    caveats.push('No tickets were compiled. Every number below is empty.');
    return caveats;
  }
  if (totalClauses === 0) {
    caveats.push(
      'No acceptance-criteria clauses were found, so AC coverage is undefined — the tickets have no criteria to cover.'
    );
  }
  if (failedCount > 0) {
    caveats.push(`${failedCount} ticket(s) failed to compile and were excluded from every metric.`);
  }
  if (!gold.set.frozen) {
    caveats.push(
      `${gold.set.version} is not frozen, so the ticket set behind these numbers can still change.`
    );
  }
  return caveats;
}

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

export function renderGenerationReport(report: GenerationReport): string {
  const row = (label: string, value: string): string => `  ${label.padEnd(22)}${value}`;
  const lines: string[] = [''];
  lines.push(`${report.prompt.version}  ×  ${report.goldSet.version}  (generation)`);
  lines.push('─'.repeat(72));
  lines.push(
    row(
      'model',
      `${report.model.id}  temp=${report.model.temperature}  seed=${report.model.seed ?? 'none'}`
    )
  );
  lines.push(
    row(
      'tickets',
      `${report.tickets.analyzed} compiled${report.tickets.failed > 0 ? `, ${report.tickets.failed} failed` : ''}`
    )
  );
  lines.push(
    row(
      'scenarios',
      `${report.scenarios.produced} produced, ${report.scenarios.perTicket ?? '–'}/ticket`
    )
  );
  lines.push('');
  lines.push(row('AC coverage', formatRate(report.acCoverage)));
  lines.push(row('hallucinated-cover', formatRate(report.hallucinatedCoverRate)));
  lines.push(row('scaffold validity', formatRate(report.scaffoldValidity)));
  lines.push(
    row(
      'cost',
      `$${report.cost.usd.toFixed(4)} total, $${(report.cost.usdPerTicket ?? 0).toFixed(4)}/ticket  (${report.cost.inputTokens}→${report.cost.outputTokens} tok)`
    )
  );

  if (report.failures.length > 0) {
    lines.push('', '  failures');
    for (const failure of report.failures) {
      lines.push(`    ${failure.externalId}: ${failure.error}`);
    }
  }
  if (report.caveats.length > 0) {
    lines.push('', '  caveats');
    for (const caveat of report.caveats) {
      lines.push(`    - ${caveat}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

function round(value: number | null, places: number): number | null {
  if (value === null) return null;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
