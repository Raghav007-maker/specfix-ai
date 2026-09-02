/**
 * Token cost accounting.
 *
 * Prices are USD per million tokens and are a snapshot — they are not fetched, and
 * they go stale. An unknown model costs 0 and warns rather than throwing, because a
 * missing price should never be the reason an analysis fails; it is a reporting
 * problem, not a correctness one.
 */
export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  'gpt-4o-mini': { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  'gpt-4o': { inputPerMillion: 2.5, outputPerMillion: 10 },
};

const warned = new Set<string>();

export function priceFor(model: string): ModelPricing | undefined {
  // Snapshot suffixes, e.g. gpt-4o-mini-2024-07-18, share the base model's price.
  if (MODEL_PRICING[model]) return MODEL_PRICING[model];
  const base = Object.keys(MODEL_PRICING).find((m) => model.startsWith(m));
  return base ? MODEL_PRICING[base] : undefined;
}

export function costUsd(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = priceFor(model);
  if (!pricing) {
    if (!warned.has(model)) {
      warned.add(model);
      console.warn(
        `[cost] no price known for model "${model}"; recording 0. ` +
          'Add it to MODEL_PRICING in packages/core/src/cost.ts.'
      );
    }
    return 0;
  }
  return (
    (inputTokens / 1_000_000) * pricing.inputPerMillion +
    (outputTokens / 1_000_000) * pricing.outputPerMillion
  );
}

/**
 * Rough token count for enforcing the input ceiling before a call is made.
 *
 * Four characters per token, which is close enough for English prose and is
 * deliberately not a tokenizer dependency. It is used only to decide whether to
 * truncate; every number that gets reported comes from the API's usage field.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
