/**
 * Spec Compiler schemas: Gherkin scenarios and Playwright scaffolds.
 *
 * Phase 2 artifacts, so they carry the same discipline Phase 1 put on flags:
 *
 *  - The model's output is validated against a zod schema before it reaches the DB or
 *    the UI (rule 1). `GherkinCompileResultSchema` is what the compiler's structured
 *    output is parsed through.
 *
 *  - Ticket text and acceptance criteria are data, never instructions. The compiler
 *    reuses the delimiter-neutralization and span-verification in packages/core, so a
 *    step or a `covers_ac` value that quotes the source is verified against it exactly
 *    as `quoted_span` is for flags. An unverified quote is cleared, not shown.
 *
 *  - A human accepts every scenario and every scaffold. The status enums mirror
 *    flags, and `isApprovedScenario` is the one predicate a scaffold emitter may gate
 *    on — there is no path from a `draft` scenario to an emitted scaffold.
 */
import { z } from 'zod';
import { sha256 } from './hash.ts';

/** Gherkin step keywords. `And`/`But` continue the previous keyword's clause type. */
export const GHERKIN_KEYWORDS = ['Given', 'When', 'Then', 'And', 'But'] as const;
export const GherkinKeywordSchema = z.enum(GHERKIN_KEYWORDS);
export type GherkinKeyword = z.infer<typeof GherkinKeywordSchema>;

export const ScenarioStepSchema = z
  .object({
    keyword: GherkinKeywordSchema,
    /** The step body, without the keyword. Non-empty: an empty step is not reviewable. */
    text: z.string().min(1),
  })
  .strict();
export type ScenarioStep = z.infer<typeof ScenarioStepSchema>;

/**
 * One scenario exactly as the model is required to return it.
 *
 * Every field is required and non-empty except the string fields that may legitimately
 * be empty — strict mode does not support optional properties, matching the flag and
 * critic schemas. `source_flag_indexes` addresses the resolved flags that drove the
 * scenario by index rather than by quoting them, for the same reason the Critic does:
 * a model asked to echo a flag's text back will eventually paraphrase it.
 */
export const LlmScenarioSchema = z
  .object({
    title: z.string().min(1),
    steps: z.array(ScenarioStepSchema).min(1).max(20),
    /**
     * Verbatim substring of the acceptance-criteria text this scenario covers, or ''
     * when the scenario is derived rather than quoting a clause. Verified against the
     * source by the compiler; a value that does not occur is cleared the way an
     * unverified `quoted_span` is.
     */
    covers_ac: z.string(),
    rationale: z.string(),
    /** Indexes into the resolved-flag list presented to the compiler. May be empty. */
    source_flag_indexes: z.array(z.number().int().min(0)),
  })
  .strict();
export type LlmScenario = z.infer<typeof LlmScenarioSchema>;

export const GherkinCompileResultSchema = z
  .object({
    /**
     * Capped above the 30-flag ceiling so a runaway response is bounded without
     * failing validation and wasting the call; the compiler trims in code and reports
     * the trim rather than discarding the whole result.
     */
    scenarios: z.array(LlmScenarioSchema).max(40),
  })
  .strict();
export type GherkinCompileResult = z.infer<typeof GherkinCompileResultSchema>;

/**
 * Scenario lifecycle. Identical shape to `FLAG_STATUSES` minus `pruned`: there is no
 * second-pass filter on scenarios, only the human gate, so there is no `pruned` state.
 * `stale` is the re-ingest mechanism — a scenario compiled against acceptance criteria
 * that have since changed is marked stale rather than silently carried forward.
 */
export const SCENARIO_STATUSES = ['draft', 'approved', 'edited', 'dismissed', 'stale'] as const;
export const ScenarioStatusSchema = z.enum(SCENARIO_STATUSES);
export type ScenarioStatus = z.infer<typeof ScenarioStatusSchema>;

export const SCENARIO_ORIGINS = ['ai_agent', 'human'] as const;
export const ScenarioOriginSchema = z.enum(SCENARIO_ORIGINS);
export type ScenarioOrigin = z.infer<typeof ScenarioOriginSchema>;

export const SCENARIO_REVIEW_DECISIONS = ['approved', 'edited', 'dismissed', 'reopened'] as const;
export const ScenarioReviewDecisionSchema = z.enum(SCENARIO_REVIEW_DECISIONS);
export type ScenarioReviewDecision = z.infer<typeof ScenarioReviewDecisionSchema>;

/** A scenario after persistence, as the dashboard and eval harness see it. */
export const ScenarioSchema = LlmScenarioSchema.extend({
  id: z.string(),
  ticket_id: z.string(),
  ticket_version_id: z.string(),
  status: ScenarioStatusSchema,
  origin: ScenarioOriginSchema.default('ai_agent'),
  dedupe_key: z.string(),
  edited_text: z.string().nullable(),
}).omit({ source_flag_indexes: true });
export type Scenario = z.infer<typeof ScenarioSchema>;

/**
 * A scenario is "accepted" — counted as a win by the acceptance-rate metric — when a
 * reviewer approved it, with or without editing the wording. Dismissed is a rejection;
 * draft and stale are not yet evidence either way.
 */
export function isApprovedScenario(status: ScenarioStatus): boolean {
  return status === 'approved' || status === 'edited';
}

export function isReviewedScenario(status: ScenarioStatus): boolean {
  return status === 'approved' || status === 'edited' || status === 'dismissed';
}

// ---------------------------------------------------------------------------
// Playwright scaffolds
//
// Deterministically derived from an approved scenario. Placeholder selectors only:
// every locator the emitter cannot know is emitted as a clearly marked placeholder
// with a suggested value, and recorded so the review UI can list what a human still
// needs to fill in.
// ---------------------------------------------------------------------------

export const SCAFFOLD_FRAMEWORKS = ['playwright'] as const;
export const ScaffoldFrameworkSchema = z.enum(SCAFFOLD_FRAMEWORKS);
export type ScaffoldFramework = z.infer<typeof ScaffoldFrameworkSchema>;

export const SELECTOR_KINDS = [
  'role',
  'label',
  'placeholder',
  'text',
  'testid',
  'url',
  'none',
] as const;
export const SelectorKindSchema = z.enum(SELECTOR_KINDS);
export type SelectorKind = z.infer<typeof SelectorKindSchema>;

export const SelectorPlaceholderSchema = z
  .object({
    /** The token that appears in the emitted code, e.g. "PLACEHOLDER_REFUND_AMOUNT". */
    name: z.string().min(1),
    kind: SelectorKindSchema,
    /** What the emitter guessed this locator is for, in plain language. */
    description: z.string().min(1),
    /** A suggested locator a human can accept or replace. Never a generated result assertion. */
    suggestion: z.string(),
  })
  .strict();
export type SelectorPlaceholder = z.infer<typeof SelectorPlaceholderSchema>;

export const ScaffoldSchema = z
  .object({
    scenario_id: z.string(),
    framework: ScaffoldFrameworkSchema,
    code: z.string().min(1),
    selector_placeholders: z.array(SelectorPlaceholderSchema),
    status: ScenarioStatusSchema,
  })
  .strict();
export type Scaffold = z.infer<typeof ScaffoldSchema>;

/**
 * Within one compile run, collapses scenarios that say the same thing twice. Same
 * mechanism as `flagDedupeKey`: lexical, not semantic. Two differently-worded
 * scenarios about the same rule both survive, and a human decides whether they are the
 * same test in review.
 *
 * Hashed to a fixed-width key (like `flagDedupeKey`) because it is a unique-constraint
 * column and a long raw title would make an unwieldy index entry.
 */
export function scenarioDedupeKey(title: string): string {
  const normalized = title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return sha256(normalized).slice(0, 32);
}

/**
 * Renders steps back into Gherkin text. This is the artifact a human reviews and the
 * scaffold emitter consumes, so it is produced in one place rather than at each call
 * site — two renderers would drift.
 */
export function renderGherkin(title: string, steps: readonly ScenarioStep[]): string {
  const lines = [`Scenario: ${title.trim()}`];
  for (const step of steps) {
    // Given/When/Then open a clause and sit at base indent; And/But continue the
    // previous clause and are indented one level, which is the conventional layout.
    const indent = step.keyword === 'And' || step.keyword === 'But' ? '    ' : '  ';
    lines.push(`${indent}${step.keyword} ${step.text.trim()}`);
  }
  return lines.join('\n');
}

const KEYWORD_BY_LOWER: Record<string, GherkinKeyword> = {
  given: 'Given',
  when: 'When',
  then: 'Then',
  and: 'And',
  but: 'But',
};

/**
 * The inverse of `renderGherkin`: parse rendered Gherkin text back into a title and
 * steps. The scaffold emitter needs structured steps, but a scenario is stored (and
 * human-edited) as rendered text, so this reads that text back.
 *
 * Deliberately lenient, because the text may have been edited by hand: it keeps the
 * first `Scenario:` line as the title and every line that opens with a Gherkin keyword
 * as a step, ignoring anything else rather than failing. Keyword case is normalized so
 * a hand-typed `given` still parses.
 */
export function parseGherkin(gherkinRaw: string): { title: string; steps: ScenarioStep[] } {
  const lines = gherkinRaw.replace(/\r\n?/g, '\n').split('\n');
  let title = '';
  const steps: ScenarioStep[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;

    const scenario = /^Scenario:\s*(.*)$/i.exec(trimmed);
    if (scenario && title === '') {
      title = (scenario[1] ?? '').trim();
      continue;
    }

    const step = /^(given|when|then|and|but)\b\s*(.*)$/i.exec(trimmed);
    if (step) {
      const keyword = KEYWORD_BY_LOWER[(step[1] ?? '').toLowerCase()];
      const text = (step[2] ?? '').trim();
      if (keyword && text) steps.push({ keyword, text });
    }
  }

  return { title, steps };
}
