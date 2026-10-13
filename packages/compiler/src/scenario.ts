/**
 * The Spec Compiler: approved acceptance criteria -> Gherkin scenarios.
 *
 * This mirrors packages/core/src/analyze.ts structurally: it renders a delimited user
 * message, neutralizes any delimiter the source text contains, makes one structured
 * call, and post-processes the result before returning. It returns data only — no DB,
 * no UI. Persistence is the caller's job.
 *
 * Two differences from the Extractor, both deliberate:
 *
 *  - What it reads is not raw ticket text but the *approved* requirement: the ticket
 *    version's acceptance criteria together with the resolved flags (each with the
 *    PM's answer). It compiles from disambiguated requirements, which is why it must
 *    be fed a version whose flags are resolved and which has been marked ready.
 *
 *  - Its output is verified the same way a flag's quoted_span is: every `covers_ac`
 *    value must occur verbatim in the acceptance-criteria text or it is cleared. A
 *    scenario that claims to cover a clause it invented is exactly the hallucination
 *    the plan's `hallucinated-step` metric exists to catch, and clearing it here keeps
 *    the UI from highlighting text that does not exist.
 */
import {
  GherkinCompileResultSchema,
  renderGherkin,
  scenarioDedupeKey,
  type LlmScenario,
  type ScenarioStep,
} from '@specfix/shared';
import {
  callForSchema,
  getConfig,
  loadPromptFrom,
  neutralizeDelimiters,
  type LlmCallRecord,
} from '@specfix/core';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { gherkinResponseFormat } from './schema.ts';

const promptsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'prompts');

export const DEFAULT_COMPILE_PROMPT = 'compile-gherkin-v1';

const CRITERIA_OPEN = '<acceptance_criteria>';
const CRITERIA_CLOSE = '</acceptance_criteria>';
/**
 * The one delimiter the requirement is wrapped in. Both the criteria and the resolved
 * clarifications sit inside it, so neutralizing this tag across all of that text is
 * what stops an injected `</acceptance_criteria>` — in the AC or in a flag answer —
 * from closing the block early. Same defense as the Extractor's `<ticket>`.
 */
const DELIMITER_TAGS = ['acceptance_criteria'] as const;

/** A resolved flag and the PM's answer, as the compiler sees it. Data, never instructions. */
export interface ResolvedFlagInput {
  /** The flag's question, already carrying any reviewer edit. */
  questionForPm: string;
  /** The PM's answer, which is what actually disambiguates the requirement. */
  answer: string;
  category: string;
  /** The flag's id, echoed into `source_flag_ids` on the stored scenario. */
  flagId: string;
}

/** The approved requirement the compiler reads. */
export interface ApprovedRequirement {
  externalKey: string;
  title: string;
  acceptanceCriteriaText: string;
  resolvedFlags: readonly ResolvedFlagInput[];
  /**
   * The ticket body the Critic pass also re-verifies against. Not used for the AC
   * span check (that is `acceptanceCriteriaText`), but carried so a caller can verify
   * steps quote the ticket rather than the AC.
   */
  ticketBody?: string;
}

export interface CompiledScenario extends LlmScenario {
  /** The rendered Gherkin text a human reviews. */
  gherkin: string;
  dedupeKey: string;
  /** False when `covers_ac` did not occur verbatim in the AC and was cleared. */
  acVerified: boolean;
  /** Flag ids resolved from `source_flag_indexes`, for the traceability graph. */
  sourceFlagIds: string[];
}

export interface CompileMeta {
  promptVersion: string;
  model: string;
  temperature: number;
  seed: number | null;
  truncated: boolean;
  attempts: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  /** Scenarios the model returned beyond the cap and that were dropped. */
  trimmed: number;
  duplicatesDropped: number;
  unverifiedAc: number;
  outOfRangeFlagRefs: number;
}

export interface CompileOutcome {
  scenarios: CompiledScenario[];
  meta: CompileMeta;
  calls: LlmCallRecord[];
}

export interface CompileOptions {
  promptName?: string;
  /** Overrides OPENAI_MODEL_COMPILE for this call. */
  model?: string;
  purpose?: LlmCallRecord['purpose'];
}

export async function compileScenarios(
  requirement: ApprovedRequirement,
  options: CompileOptions = {}
): Promise<CompileOutcome> {
  const config = getConfig();
  const prompt = await loadPromptFrom(promptsDir, options.promptName ?? DEFAULT_COMPILE_PROMPT);
  const model = options.model ?? config.modelCompile;

  const rendered = renderRequirement(requirement, config.maxTicketInputTokens);

  const { result, calls } = await callForSchema(
    {
      purpose: options.purpose ?? 'compile_gherkin',
      promptVersion: prompt.version,
      model,
      systemMessage: prompt.systemMessage,
      userMessage: rendered.userMessage,
    },
    GherkinCompileResultSchema,
    gherkinResponseFormat()
  );

  const { scenarios, duplicatesDropped, unverifiedAc, outOfRangeFlagRefs, trimmed } = postProcess(
    result.scenarios,
    requirement.acceptanceCriteriaText,
    requirement.resolvedFlags
  );

  return {
    scenarios,
    meta: {
      promptVersion: prompt.version,
      model: calls.at(-1)?.model ?? model,
      temperature: config.temperature,
      seed: config.seed,
      truncated: rendered.truncated,
      attempts: calls.length,
      inputTokens: sum(calls, (c) => c.inputTokens),
      outputTokens: sum(calls, (c) => c.outputTokens),
      costUsd: sum(calls, (c) => c.costUsd),
      latencyMs: sum(calls, (c) => c.latencyMs),
      trimmed,
      duplicatesDropped,
      unverifiedAc,
      outOfRangeFlagRefs,
    },
    calls,
  };
}

interface RenderedRequirement {
  userMessage: string;
  truncated: boolean;
}

const TRUNCATION_MARKER = '\n\n[... acceptance criteria truncated for length ...]';

/**
 * Builds the delimited user message: the acceptance criteria, then the resolved flags
 * with their answers.
 *
 * The AC block is kept whole where possible, because it is what `covers_ac` is
 * verified against and truncating it would clear legitimate spans. The resolved-flag
 * block is what gets cut when the input is too large, since the flags are supporting
 * context rather than the requirement itself.
 */
export function renderRequirement(
  requirement: ApprovedRequirement,
  maxTokens = 8000
): RenderedRequirement {
  const neutralize = (text: string): string => neutralizeDelimiters(text, DELIMITER_TAGS);

  const criteria = neutralize(requirement.acceptanceCriteriaText);

  const flagPayload = requirement.resolvedFlags.map((flag, index) => ({
    index,
    category: flag.category,
    question: flag.questionForPm,
    answer: flag.answer,
  }));
  let flagsJson = neutralize(JSON.stringify(flagPayload, null, 2));

  const build = (flags: string): string =>
    [
      `Key: ${neutralize(requirement.externalKey)}`,
      `Title: ${neutralize(requirement.title)}`,
      '',
      'Approved acceptance criteria:',
      criteria || '(none provided)',
      '',
      'Resolved clarifications (each is a decision already made by the PM):',
      flags,
    ].join('\n');

  let truncated = false;
  let body = build(flagsJson);

  if (estimate(body) > maxTokens) {
    truncated = true;
    // Budget for the flag block only; the AC stays whole so spans stay verifiable.
    const overhead = estimate(build(''));
    const budgetChars = Math.max(0, (maxTokens - overhead) * 4 - TRUNCATION_MARKER.length);
    flagsJson = flagsJson.slice(0, budgetChars) + TRUNCATION_MARKER;
    body = build(flagsJson);
  }

  return {
    userMessage: `${CRITERIA_OPEN}\n${body}\n${CRITERIA_CLOSE}`,
    truncated,
  };
}

function postProcess(
  raw: LlmScenario[],
  acceptanceCriteriaText: string,
  resolvedFlags: readonly ResolvedFlagInput[]
): {
  scenarios: CompiledScenario[];
  duplicatesDropped: number;
  unverifiedAc: number;
  outOfRangeFlagRefs: number;
  trimmed: number;
} {
  const seen = new Set<string>();
  const scenarios: CompiledScenario[] = [];
  let duplicatesDropped = 0;
  let unverifiedAc = 0;
  let outOfRangeFlagRefs = 0;

  // The plan caps stored scenarios at 30 per version. Anything beyond is dropped and
  // reported rather than failing validation, so a runaway response still yields a
  // usable result with a visible trim count.
  const capped = raw.slice(0, 30);
  const trimmed = raw.length - capped.length;

  for (const scenario of capped) {
    const dedupeKey = scenarioDedupeKey(scenario.title);
    if (seen.has(dedupeKey)) {
      duplicatesDropped += 1;
      continue;
    }
    seen.add(dedupeKey);

    const coversAc = scenario.covers_ac.trim();
    const acVerified = coversAc === '' || acceptanceCriteriaText.includes(coversAc);
    if (!acVerified) unverifiedAc += 1;

    const sourceFlagIds: string[] = [];
    for (const index of scenario.source_flag_indexes) {
      const flag = resolvedFlags[index];
      if (flag) sourceFlagIds.push(flag.flagId);
      else outOfRangeFlagRefs += 1;
    }

    scenarios.push({
      ...scenario,
      // Clear an unverifiable cover rather than storing a quote the source does not
      // contain; the scenario itself is kept, because a derived scenario with no
      // clause is legitimate (covers_ac may be '' by design).
      covers_ac: acVerified ? scenario.covers_ac : '',
      steps: scenario.steps.map(normalizeStep),
      gherkin: renderGherkin(scenario.title, scenario.steps),
      dedupeKey,
      acVerified,
      sourceFlagIds,
    });
  }

  return { scenarios, duplicatesDropped, unverifiedAc, outOfRangeFlagRefs, trimmed };
}

function normalizeStep(step: ScenarioStep): ScenarioStep {
  return { keyword: step.keyword, text: step.text.trim() };
}

/** Four characters per token, matching packages/core's estimateTokens. */
function estimate(text: string): number {
  return Math.ceil(text.length / 4);
}

function sum<T>(items: T[], pick: (item: T) => number): number {
  return items.reduce((total, item) => total + pick(item), 0);
}
