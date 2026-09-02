/**
 * Gold sets: frozen, human-authored labels that eval runs are scored against.
 *
 * The design problem this solves: precision needs a verdict on *this run's* flags,
 * but every prompt change produces new flags, and a static file cannot contain
 * verdicts for output that does not exist yet. Re-labeling by hand on every prompt
 * tweak would make the harness too slow to use, which means it would not get used.
 *
 * The mechanism is verdict carry-forward keyed on `dedupeKey` (category +
 * normalized what_unclear). A reviewer's judgment is recorded against that key, so
 * when a new prompt version emits a flag that was already judged for the same
 * ticket, the verdict is reused. Flags with no recorded verdict are reported as
 * `unjudged` and excluded from the rate — never counted as false positives.
 *
 * Consequences, both stated in every report rather than buried here:
 *  - Precision is computed over judged flags only, with the unjudged count shown.
 *  - Recall is a lower bound, because an unjudged flag cannot yet be credited with
 *    covering a gap.
 * Both tighten toward the truth as reviewers work through the labeling queue.
 *
 * Gold sets are frozen once used in a reported result. Fixing a label means
 * creating gold-v2, not editing gold-v1 — otherwise a metric can move because
 * someone changed the answer key, and the git diff looks identical to a real change.
 */
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { FlagCategorySchema } from '@specfix/shared';

/**
 * `independentOfPrompt: false` means this reviewer saw or wrote the prompt. Their
 * labels are still useful for iteration but cannot support a headline precision
 * claim, so the report has to surface it. Week 5 exists to get labels where this
 * is true.
 */
export const GoldReviewerSchema = z
  .object({
    id: z.string().min(1),
    role: z.string().min(1),
    independentOfPrompt: z.boolean(),
  })
  .strict();

export const GoldGapSchema = z
  .object({
    /** Stable id, referenced by verdicts. Convention: `<externalId>-g<n>`. */
    id: z.string().min(1),
    reviewerId: z.string().min(1),
    description: z.string().min(1),
    /** Optional category hint; not used for matching, only for the breakdown. */
    category: FlagCategorySchema.optional(),
  })
  .strict();

export const GoldVerdictSchema = z
  .object({
    dedupeKey: z.string().min(1),
    /** `real` = the reviewer accepted or edited the flag. `noise` = dismissed. */
    verdict: z.enum(['real', 'noise']),
    reviewerId: z.string().min(1),
    /** Gaps from this reviewer's blind list that this flag covers. */
    coversGapIds: z.array(z.string()).default([]),
    /** Human-readable copy of what_unclear, so the file is reviewable in a PR. */
    label: z.string().default(''),
    note: z.string().default(''),
  })
  .strict();

export const GoldTicketSchema = z
  .object({
    externalId: z.string().min(1),
    gaps: z.array(GoldGapSchema).default([]),
    verdicts: z.array(GoldVerdictSchema).default([]),
  })
  .strict();

export const GoldSetSchema = z
  .object({
    version: z.string().regex(/^gold-v\d+$/, 'version must look like gold-v1'),
    /** Once true, this file is an answer key and must not be edited. */
    frozen: z.boolean(),
    frozenAt: z.string().nullable(),
    /** Ticket directory, relative to the gold file. */
    ticketsDir: z.string().min(1),
    notes: z.string().default(''),
    reviewers: z.array(GoldReviewerSchema).min(1),
    tickets: z.array(GoldTicketSchema),
  })
  .strict();

export type GoldReviewer = z.infer<typeof GoldReviewerSchema>;
export type GoldGap = z.infer<typeof GoldGapSchema>;
export type GoldVerdict = z.infer<typeof GoldVerdictSchema>;
export type GoldTicket = z.infer<typeof GoldTicketSchema>;
export type GoldSet = z.infer<typeof GoldSetSchema>;

export interface LoadedGoldSet {
  set: GoldSet;
  /** Absolute path to the ticket directory. */
  ticketsDir: string;
  path: string;
}

export class GoldSetError extends Error {
  constructor(
    message: string,
    readonly path: string
  ) {
    super(`${path}: ${message}`);
    this.name = 'GoldSetError';
  }
}

export async function loadGoldSet(path: string): Promise<LoadedGoldSet> {
  const absolute = isAbsolute(path) ? path : resolve(process.cwd(), path);

  let raw: string;
  try {
    raw = await readFile(absolute, 'utf8');
  } catch {
    throw new GoldSetError('cannot read gold set', absolute);
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new GoldSetError(
      `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      absolute
    );
  }

  const parsed = GoldSetSchema.safeParse(json);
  if (!parsed.success) {
    throw new GoldSetError(parsed.error.issues.map(describeIssue).join('; '), absolute);
  }

  const set = parsed.data;
  for (const problem of findInconsistencies(set)) {
    throw new GoldSetError(problem, absolute);
  }

  return {
    set,
    ticketsDir: resolve(dirname(absolute), set.ticketsDir),
    path: absolute,
  };
}

/**
 * Structural checks zod cannot express. Every one of these has a failure mode that
 * silently corrupts a metric rather than crashing, which is why they are errors and
 * not warnings.
 */
export function findInconsistencies(set: GoldSet): string[] {
  const problems: string[] = [];
  const reviewerIds = new Set(set.reviewers.map((r) => r.id));

  if (reviewerIds.size !== set.reviewers.length) {
    problems.push('duplicate reviewer id');
  }

  const seenTickets = new Set<string>();
  for (const ticket of set.tickets) {
    const where = `ticket ${ticket.externalId}`;

    if (seenTickets.has(ticket.externalId)) {
      problems.push(`${where}: appears twice`);
    }
    seenTickets.add(ticket.externalId);

    const gapIds = new Set<string>();
    for (const gap of ticket.gaps) {
      if (gapIds.has(gap.id)) {
        // Duplicate ids would let one gap be double-counted in the recall
        // denominator, or shadow another gap entirely.
        problems.push(`${where}: duplicate gap id "${gap.id}"`);
      }
      gapIds.add(gap.id);
      if (!reviewerIds.has(gap.reviewerId)) {
        problems.push(`${where}: gap "${gap.id}" cites unknown reviewer "${gap.reviewerId}"`);
      }
    }

    const seenKeys = new Set<string>();
    for (const verdict of ticket.verdicts) {
      const key = `${verdict.reviewerId}:${verdict.dedupeKey}`;
      if (seenKeys.has(key)) {
        problems.push(
          `${where}: two verdicts from "${verdict.reviewerId}" for dedupeKey "${verdict.dedupeKey}"`
        );
      }
      seenKeys.add(key);

      if (!reviewerIds.has(verdict.reviewerId)) {
        problems.push(`${where}: verdict cites unknown reviewer "${verdict.reviewerId}"`);
      }

      // A dismissed flag that also "covers a gap" is a labeling contradiction: the
      // reviewer called it noise and credited it with finding something real.
      if (verdict.verdict === 'noise' && verdict.coversGapIds.length > 0) {
        problems.push(`${where}: dedupeKey "${verdict.dedupeKey}" is marked noise but covers gaps`);
      }

      for (const gapId of verdict.coversGapIds) {
        if (!gapIds.has(gapId)) {
          problems.push(`${where}: dedupeKey "${verdict.dedupeKey}" covers unknown gap "${gapId}"`);
        }
      }
    }
  }

  return problems;
}

/** Verdicts indexed for lookup during scoring: `externalId` → `dedupeKey` → verdicts. */
export type VerdictIndex = Map<string, Map<string, GoldVerdict[]>>;

export function indexVerdicts(set: GoldSet): VerdictIndex {
  const index: VerdictIndex = new Map();
  for (const ticket of set.tickets) {
    const byKey = new Map<string, GoldVerdict[]>();
    for (const verdict of ticket.verdicts) {
      const list = byKey.get(verdict.dedupeKey);
      if (list) list.push(verdict);
      else byKey.set(verdict.dedupeKey, [verdict]);
    }
    index.set(ticket.externalId, byKey);
  }
  return index;
}

/** Reviewers whose labels can back a headline precision claim. */
export function independentReviewers(set: GoldSet): GoldReviewer[] {
  return set.reviewers.filter((r) => r.independentOfPrompt);
}

function describeIssue(issue: z.ZodIssue): string {
  const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
  return `${path}: ${issue.message}`;
}
