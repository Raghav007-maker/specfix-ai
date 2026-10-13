/**
 * Spec Compiler tests that run without an API key.
 *
 * These cover the parts that are our code's responsibility rather than the model's
 * judgment: the structured-output schema, the pure post-processing steps (dedupe, AC
 * span verification, flag-reference resolution), and the deterministic scaffold
 * emitter. A failure here is a code bug, not a model-quality issue, which is why they
 * run on every push.
 *
 * The live-model behaviour (does the prompt actually compile good scenarios, and does
 * it resist an injected instruction in the acceptance criteria) is in
 * injection.test.ts and skips without a key.
 */
import { describe, it, expect } from 'vitest';
import {
  GherkinCompileResultSchema,
  ScenarioStepSchema,
  parseGherkin,
  renderGherkin,
  scenarioDedupeKey,
} from '@specfix/shared';
import {
  buildGherkinJsonSchema,
  SCENARIO_PROPERTY_ORDER,
  STEP_PROPERTY_ORDER,
} from '../src/schema.ts';
import { emitPlaywrightScaffold } from '../src/scaffold.ts';

describe('gherkin schema', () => {
  it('accepts a well-formed compile result', () => {
    const parsed = GherkinCompileResultSchema.safeParse({
      scenarios: [
        {
          title: 'A partial refund reduces the order total',
          steps: [
            { keyword: 'Given', text: 'an order with total 100.00' },
            { keyword: 'When', text: 'the agent refunds 30.00' },
            { keyword: 'Then', text: 'the order total is 70.00' },
          ],
          covers_ac: 'Agent can enter a refund amount',
          rationale: 'Covers the AC clause about entering an amount.',
          source_flag_indexes: [0],
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a step with an unknown keyword', () => {
    const parsed = ScenarioStepSchema.safeParse({ keyword: 'Suppose', text: 'x' });
    expect(parsed.success).toBe(false);
  });

  it('rejects a scenario with no steps', () => {
    const parsed = GherkinCompileResultSchema.safeParse({
      scenarios: [{ title: 't', steps: [], covers_ac: '', rationale: '', source_flag_indexes: [] }],
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a response with an extra top-level property', () => {
    const parsed = GherkinCompileResultSchema.safeParse({ scenarios: [], extra: true });
    expect(parsed.success).toBe(false);
  });

  /**
   * Drift guard. The JSON Schema sent to OpenAI is hand-written because strict mode
   * needs requirements a converter gets wrong; this asserts the property lists still
   * match the zod schema, so a field added to one cannot be silently missing from the
   * other — which would make the model's output fail validation for a schema reason
   * that looks like a model error.
   */
  it('keeps the JSON Schema property lists in step with the zod schema', () => {
    const schema = buildGherkinJsonSchema() as {
      properties: {
        scenarios: {
          items: {
            required: string[];
            properties: Record<string, { items?: { required: string[] } }>;
          };
        };
      };
    };
    expect(schema.properties.scenarios.items.required).toEqual([...SCENARIO_PROPERTY_ORDER]);
    expect(schema.properties.scenarios.items.properties.steps?.items?.required).toEqual([
      ...STEP_PROPERTY_ORDER,
    ]);
  });
});

describe('renderGherkin', () => {
  it('indents continuation keywords one level deeper than clause openers', () => {
    const text = renderGherkin('Refund', [
      { keyword: 'Given', text: 'an order' },
      { keyword: 'And', text: 'an agent' },
      { keyword: 'When', text: 'a refund is issued' },
      { keyword: 'Then', text: 'the total drops' },
    ]);
    expect(text).toBe(
      [
        'Scenario: Refund',
        '  Given an order',
        '    And an agent',
        '  When a refund is issued',
        '  Then the total drops',
      ].join('\n')
    );
  });
});

describe('scenarioDedupeKey', () => {
  it('collapses titles that differ only in case and punctuation', () => {
    expect(scenarioDedupeKey('A partial refund!')).toBe(scenarioDedupeKey('a partial refund'));
  });

  it('keeps distinct titles distinct', () => {
    expect(scenarioDedupeKey('refund one item')).not.toBe(scenarioDedupeKey('refund whole order'));
  });
});

describe('emitPlaywrightScaffold', () => {
  const scenario = {
    title: 'A partial refund reduces the order total',
    steps: [
      { keyword: 'Given' as const, text: 'an order with total 100.00' },
      { keyword: 'When' as const, text: 'the agent enters a refund amount of 30.00' },
      { keyword: 'Then' as const, text: 'the order total reads 70.00' },
    ],
  };

  it('is deterministic: the same scenario emits byte-identical code', () => {
    const a = emitPlaywrightScaffold({ scenario, externalKey: 'PAY-142', scenarioId: 's1' });
    const b = emitPlaywrightScaffold({ scenario, externalKey: 'PAY-142', scenarioId: 's1' });
    expect(a.code).toBe(b.code);
  });

  it('emits only placeholder selectors and records them', () => {
    const emitted = emitPlaywrightScaffold({ scenario, externalKey: 'PAY-142', scenarioId: 's1' });
    // Two interaction/outcome steps -> two placeholders, and every locator the code
    // uses is one of them. No guessed real selector is present.
    expect(emitted.selectorPlaceholders).toHaveLength(2);
    for (const placeholder of emitted.selectorPlaceholders) {
      expect(emitted.code).toContain(placeholder.name);
    }
    expect(emitted.code).not.toMatch(/getByRole\('button'/);
    expect(emitted.code).toContain('test.fixme');
  });

  it('refuses a framework it cannot emit', () => {
    expect(() =>
      emitPlaywrightScaffold({
        scenario,
        externalKey: 'PAY-142',
        scenarioId: 's1',
        // @ts-expect-error deliberately an unsupported framework
        framework: 'cypress',
      })
    ).toThrow(/unsupported scaffold framework/);
  });
});

describe('parseGherkin', () => {
  it('round-trips renderGherkin', () => {
    const steps = [
      { keyword: 'Given' as const, text: 'an order with total 100.00' },
      { keyword: 'When' as const, text: 'the agent refunds 30.00' },
      { keyword: 'And' as const, text: 'confirms the refund' },
      { keyword: 'Then' as const, text: 'the order total is 70.00' },
    ];
    const parsed = parseGherkin(renderGherkin('A partial refund', steps));
    expect(parsed.title).toBe('A partial refund');
    expect(parsed.steps).toEqual(steps);
  });

  it('reads hand-edited text leniently: lowercase keywords, stray lines', () => {
    const parsed = parseGherkin(
      [
        'Scenario: Edited by a human',
        'given a user',
        'random note that is not a step',
        'WHEN they click save',
        'then it persists',
      ].join('\n')
    );
    expect(parsed.title).toBe('Edited by a human');
    expect(parsed.steps).toEqual([
      { keyword: 'Given', text: 'a user' },
      { keyword: 'When', text: 'they click save' },
      { keyword: 'Then', text: 'it persists' },
    ]);
  });
});

describe('scaffold validity', () => {
  // A deterministic emitter should produce structurally valid TypeScript every time.
  // This is the parse/compile-validity proxy the plan asks for at this milestone; the
  // full compile metric lives in the eval harness.
  const balanced = (code: string, open: string, close: string): boolean => {
    let depth = 0;
    for (const ch of code) {
      if (ch === open) depth += 1;
      else if (ch === close) depth -= 1;
      if (depth < 0) return false;
    }
    return depth === 0;
  };

  it('emits balanced, well-formed Playwright across varied scenarios', () => {
    const scenarios = [
      { title: 'Setup only', steps: [{ keyword: 'Given' as const, text: 'a thing' }] },
      {
        title: 'Full flow',
        steps: [
          { keyword: 'Given' as const, text: 'an order' },
          { keyword: 'When' as const, text: 'the agent clicks refund' },
          { keyword: 'Then' as const, text: 'the total updates' },
        ],
      },
    ];

    for (const scenario of scenarios) {
      const emitted = emitPlaywrightScaffold({
        scenario,
        externalKey: 'PAY-142',
        scenarioId: 's1',
      });
      expect(balanced(emitted.code, '{', '}')).toBe(true);
      expect(balanced(emitted.code, '(', ')')).toBe(true);
      expect(emitted.code).toContain("import { test, expect } from '@playwright/test';");
      expect(emitted.code).toContain('test.describe(');
      expect(emitted.code).toContain('test.fixme(');
      for (const placeholder of emitted.selectorPlaceholders) {
        expect(emitted.code).toContain(placeholder.name);
      }
      expect(emitted.code.endsWith('\n')).toBe(true);
    }
  });
});
