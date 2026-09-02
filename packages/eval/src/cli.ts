/**
 * The eval CLI.
 *
 *   npm run eval -- validate --set gold-v1
 *   npm run eval -- run --set gold-v1 --prompt single-shot-v1
 *   npm run eval -- run --set gold-v1 --prompt two-pass-v1 --limit 5 --no-write
 *   npm run eval -- show --set gold-v1 --prompt single-shot-v1
 *   npm run eval -- compare --set gold-v1 --a single-shot-v1 --b two-pass-v1
 *
 * `validate` needs no API key and no network, which is why it is the subcommand CI
 * runs. `run` costs money and is invoked by a human.
 */
import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { hasOpenAiCredentials } from '@specfix/core';
import { findInconsistencies, loadGoldSet, GoldSetError } from './gold.ts';
import { runPrompt } from './runner.ts';
import { scoreRun } from './score.ts';
import {
  buildReport,
  diffReports,
  readReport,
  renderDiff,
  renderReport,
  reportPath,
  writeReport,
} from './report.ts';

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
const GOLD_DIR = join(REPO_ROOT, 'fixtures', 'gold');
const RUNS_DIR = join(REPO_ROOT, 'fixtures', 'eval-runs');

const USAGE = `
specfix eval

  validate --set <name>
      Load and check a gold set. No API key, no network, no cost.

  run --set <name> --prompt <name> [options]
      Analyze the set's tickets and score the result.
      --limit <n>          only the first n tickets
      --model <id>         override the configured model
      --reviewer <a,b>     score against these reviewers only
      --concurrency <n>    parallel analyses (default 3)
      --no-write           print the report without writing it
      --check              exit 1 if precision or recall regressed

  show --set <name> --prompt <name>
      Print the committed report.

  compare --set <name> --a <prompt> --b <prompt>
      Diff two committed reports.
`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const flags = parseFlags(rest);

  switch (command) {
    case 'validate':
      return validate(flags);
    case 'run':
      return run(flags);
    case 'show':
      return show(flags);
    case 'compare':
      return compare(flags);
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(USAGE);
      return command === undefined ? 2 : 0;
    default:
      process.stderr.write(`unknown command "${command}"\n${USAGE}`);
      return 2;
  }
}

async function validate(flags: Flags): Promise<number> {
  const gold = await loadGoldSet(goldPath(required(flags, 'set')));
  const problems = findInconsistencies(gold.set);

  // loadGoldSet already throws on these; reaching here with problems would mean the
  // two checks disagree, which is worth surfacing loudly rather than passing.
  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`  ${problem}\n`);
    return 1;
  }

  const gaps = gold.set.tickets.reduce((n, t) => n + t.gaps.length, 0);
  const verdicts = gold.set.tickets.reduce((n, t) => n + t.verdicts.length, 0);
  const independent = gold.set.reviewers.filter((r) => r.independentOfPrompt);

  process.stdout.write(
    [
      `${gold.set.version} ok${gold.set.frozen ? ' (frozen)' : ' (not frozen)'}`,
      `  tickets    ${gold.set.tickets.length}`,
      `  gaps       ${gaps}`,
      `  verdicts   ${verdicts}`,
      `  reviewers  ${gold.set.reviewers.length} (${independent.length} independent of the prompt)`,
      `  tickets in ${gold.ticketsDir}`,
      '',
    ].join('\n')
  );

  if (gaps === 0 && verdicts === 0) {
    process.stdout.write(
      'This set has no labels yet, so a run against it can report cost and flag volume but not precision or recall.\n'
    );
  }
  return 0;
}

async function run(flags: Flags): Promise<number> {
  const setName = required(flags, 'set');
  const promptName = required(flags, 'prompt');

  if (!hasOpenAiCredentials()) {
    process.stderr.write('OPENAI_API_KEY is not set. `run` makes real API calls.\n');
    return 1;
  }

  const gold = await loadGoldSet(goldPath(setName));
  const reviewerIds = flags['reviewer']
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const summary = await runPrompt({
    gold,
    promptName,
    model: flags['model'],
    limit: numeric(flags, 'limit'),
    concurrency: numeric(flags, 'concurrency') ?? 3,
    onProgress: (event) => {
      const status = event.error ? `FAILED ${event.error}` : `${event.flagCount} flags`;
      process.stderr.write(`  [${event.index}/${event.total}] ${event.externalId}  ${status}\n`);
    },
  });

  const scorecard = scoreRun(gold.set, summary.runs, reviewerIds ? { reviewerIds } : {});
  const report = buildReport({
    gold,
    promptName,
    summary,
    scorecard,
    generatedAt: new Date().toISOString(),
  });

  process.stdout.write(renderReport(report));
  process.stderr.write(
    `  wall-clock latency total: ${(summary.latencyMsTotal / 1000).toFixed(1)}s\n`
  );

  const path = reportPath(RUNS_DIR, gold.set.version, promptName);
  const previous = await readReport(path);
  let regressed = false;

  if (previous) {
    const diff = diffReports(previous, report);
    regressed = diff.precisionRegressed || diff.recallRegressed;
    process.stdout.write(`\n${renderDiff(diff)}\n`);
  }

  if (flags['no-write'] === undefined) {
    await writeReport(path, report);
    process.stdout.write(`\n  wrote ${path}\n`);
  }

  return flags['check'] !== undefined && regressed ? 1 : 0;
}

async function show(flags: Flags): Promise<number> {
  const gold = await loadGoldSet(goldPath(required(flags, 'set')));
  const promptName = required(flags, 'prompt');
  const path = reportPath(RUNS_DIR, gold.set.version, promptName);
  const report = await readReport(path);

  if (!report) {
    process.stderr.write(`no committed report at ${path}\n`);
    return 1;
  }
  process.stdout.write(renderReport(report));
  return 0;
}

async function compare(flags: Flags): Promise<number> {
  const gold = await loadGoldSet(goldPath(required(flags, 'set')));
  const a = required(flags, 'a');
  const b = required(flags, 'b');

  const reportA = await readReport(reportPath(RUNS_DIR, gold.set.version, a));
  const reportB = await readReport(reportPath(RUNS_DIR, gold.set.version, b));

  if (!reportA || !reportB) {
    process.stderr.write(`missing committed report for ${!reportA ? a : b}\n`);
    return 1;
  }

  process.stdout.write(renderReport(reportA));
  process.stdout.write(renderReport(reportB));
  process.stdout.write(`\n  ${a} → ${b}\n${renderDiff(diffReports(reportA, reportB))}\n`);
  return 0;
}

type Flags = Record<string, string | undefined>;

/** `--key value` and bare `--flag`. Enough for this CLI; no dependency needed. */
function parseFlags(argv: readonly string[]): Flags {
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] as string;
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = '';
    }
  }
  return flags;
}

class UsageError extends Error {}

function required(flags: Flags, key: string): string {
  const value = flags[key];
  if (value === undefined || value === '') {
    throw new UsageError(`--${key} is required`);
  }
  return value;
}

function numeric(flags: Flags, key: string): number | undefined {
  const value = flags[key];
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new UsageError(`--${key} must be a positive integer`);
  }
  return parsed;
}

function goldPath(name: string): string {
  return join(GOLD_DIR, name.endsWith('.json') ? name : `${name}.json`);
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n${USAGE}`);
      process.exitCode = 2;
      return;
    }
    if (error instanceof GoldSetError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
    );
    process.exitCode = 1;
  });
