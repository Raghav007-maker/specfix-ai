/**
 * The Playwright scaffold emitter.
 *
 * Deliberately a deterministic codegen step, not an LLM call: the plan calls for stable,
 * reviewable output, and a scaffold whose shape changes between two runs of the same
 * approved scenario would be unreviewable. So this module makes no model call and has
 * no prompt — it is a pure function of a scenario's title and steps.
 *
 * Placeholder selectors only. The emitter cannot know a page's real DOM, and a guessed
 * locator is a flaky or wrong test waiting to happen — every competitor in this space
 * gates selector generation behind a human for exactly this reason. So each step that
 * implies browser interaction emits a clearly named `PLACEHOLDER_*` locator and records
 * it in `selectorPlaceholders`, which the review UI shows as a checklist.
 *
 * `test.fixme` is intentional: it marks the spec as pending so a scaffold committed by
 * mistake fails loudly in CI rather than silently passing against an empty assertion.
 */
import type {
  ScenarioStep,
  ScaffoldFramework,
  SelectorPlaceholder,
  SelectorKind,
} from '@specfix/shared';

export interface ScaffoldSource {
  title: string;
  steps: readonly ScenarioStep[];
}

export interface EmitScaffoldInput {
  scenario: ScaffoldSource;
  /** Included in the file header comment so a reader knows which ticket this came from. */
  externalKey: string;
  scenarioId: string;
  framework?: ScaffoldFramework;
}

export interface EmittedScaffold {
  scenarioId: string;
  framework: ScaffoldFramework;
  code: string;
  selectorPlaceholders: SelectorPlaceholder[];
}

/** The Playwright tag linking a test to its SpecFix scenario, e.g. `@sf-<uuid>`. */
export function scenarioTag(scenarioId: string): string {
  return `@sf-${scenarioId}`;
}

export function emitPlaywrightScaffold(input: EmitScaffoldInput): EmittedScaffold {
  const framework: ScaffoldFramework = input.framework ?? 'playwright';
  if (framework !== 'playwright') {
    throw new Error(`unsupported scaffold framework: ${framework}`);
  }

  const placeholders: SelectorPlaceholder[] = [];
  const bodyLines: string[] = [];

  // The Given steps are setup. Each becomes a comment describing the precondition —
  // the emitter cannot fabricate a page fixture, so it names it for the human.
  for (const step of input.scenario.steps) {
    if (step.keyword === 'Given') {
      bodyLines.push(`  // Given: ${step.text}`);
    }
  }

  // Interaction and outcome steps carry the placeholders: one per step, so a reviewer
  // fills in a locator per observable action or assertion.
  let placeholderIndex = 0;
  for (const step of input.scenario.steps) {
    if (step.keyword === 'Given') continue;
    placeholderIndex += 1;
    const name = `PLACEHOLDER_${placeholderIndex}_${slug(step.text)}`;
    const kind: SelectorKind = step.keyword === 'Then' ? 'testid' : 'role';
    placeholders.push({
      name,
      kind,
      description: `${step.keyword}: ${step.text}`,
      suggestion: suggestLocator(step),
    });
    bodyLines.push(`  // ${step.keyword}: ${step.text}`);
    bodyLines.push(`  await page.locator('${name}'); // TODO: replace with a real locator`);
  }

  const code = [
    `// Generated scaffold for ${input.externalKey} — scenario ${input.scenarioId}`,
    `// Placeholder selectors only. A human must fill in the real locators before this`,
    `// spec is run; see the checklist in the review UI.`,
    `import { test, expect } from '@playwright/test';`,
    ``,
    `test.describe(${JSON.stringify(input.externalKey)}, () => {`,
    // The tag is how CI results find their way back to this scenario: Playwright puts it
    // in the JSON report's `tags`, and /api/ci/results matches on it. Keep it when
    // editing the test.
    `  test.fixme(${JSON.stringify(input.scenario.title)}, { tag: ${JSON.stringify(scenarioTag(input.scenarioId))} }, async ({ page }) => {`,
    ...bodyLines,
    `  });`,
    `});`,
    ``,
  ].join('\n');

  return {
    scenarioId: input.scenarioId,
    framework,
    code,
    selectorPlaceholders: placeholders,
  };
}

/**
 * A starting point a human edits, never a finished locator. `getByRole` is the
 * accessible-by-default choice; the human replaces the placeholder with the real role
 * and name.
 */
function suggestLocator(step: ScenarioStep): string {
  if (step.keyword === 'Then') {
    return `expect(page.getByTestId('<real-testid>')).toBeVisible()`;
  }
  if (/\bbutton|click|press|submit\b/i.test(step.text)) {
    return `page.getByRole('button', { name: '<real-label>' })`;
  }
  if (/\btype|enter|fill|input|amount\b/i.test(step.text)) {
    return `page.getByLabel('<real-field-label>')`;
  }
  if (/\burl|navigate|open|visit|goto\b/i.test(step.text)) {
    return `page.goto('<real-url>')`;
  }
  return `page.getByRole('<real-role>', { name: '<real-name>' })`;
}

/** Uppercase snake slug, capped so a long step does not produce an absurd identifier. */
function slug(text: string): string {
  const cleaned = text
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned.slice(0, 32) || 'STEP';
}
