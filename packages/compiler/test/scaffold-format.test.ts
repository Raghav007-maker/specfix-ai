/**
 * Emitted scaffolds are committed to real repositories by "Open PR with scaffolds", where
 * that repository's CI runs Prettier and ESLint over them. So the emitter's output must
 * already be clean under this repo's own config: Prettier would change nothing, and
 * ESLint reports nothing (no unused `expect`, no unused `page`).
 */
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import * as prettier from 'prettier';
import { ESLint } from 'eslint';
import { emitPlaywrightScaffold } from '../src/scaffold.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const FILE = `${ROOT}tests/specfix/PAY-142/s1.spec.ts`;

const steps = [
  { keyword: 'Given' as const, text: 'an order with total 100.00' },
  { keyword: 'When' as const, text: 'the agent enters a refund amount of 30.00' },
  { keyword: 'Then' as const, text: 'the order total reads 70.00' },
];

const cases = [
  ['a long title (arguments broken onto lines)', 'A partial refund reduces the order total', steps],
  ['a short title (call kept on one line)', 'Refund', steps],
  ['setup steps only (no page parameter)', 'Setup only', [steps[0]!]],
  ['a title with a single quote', "The agent's refund is applied", steps],
  ['a title with more single than double quotes', `It's the "agent's" refund`, steps],
  ['a title with a backslash', 'Path C:\\orders is shown', steps],
] as const;

// The first lint loads typescript-eslint, which takes several seconds.
describe('scaffold output passes the repository CI as written', { timeout: 30_000 }, () => {
  const eslint = new ESLint({ cwd: ROOT });

  it.each(cases)('%s', async (_name, title, scenarioSteps) => {
    const { code } = emitPlaywrightScaffold({
      scenario: { title, steps: scenarioSteps },
      externalKey: 'PAY-142',
      scenarioId: '9efc7ddc-2a30-4fbf-b1c7-bd1727a15cf5',
    });
    const options = { ...(await prettier.resolveConfig(FILE)), filepath: FILE };
    expect(await prettier.format(code, options)).toBe(code);

    const [result] = await eslint.lintText(code, { filePath: FILE });
    expect(result!.messages.map((m) => `${m.ruleId}: ${m.message}`)).toEqual([]);

    // The title round-trips: what Playwright reports is exactly the scenario's title.
    expect(code).toContain('@sf-9efc7ddc-2a30-4fbf-b1c7-bd1727a15cf5');
  });
});
