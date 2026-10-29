/**
 * Anthropic first-party list prices, USD per million tokens, by model family and version (claude-api skill, cached
 * 2026-10-06). Keys are `<family>-<major>[.<minor>]`. A model not listed here is "not priced" (null), never guessed.
 * ponytail: cache reads/writes and Haiku 5.5's >100K-prompt rate are not priced; the estimate is input + output only.
 */
export const PRICES: Record<string, { input: number; output: number }> = {
  'fable-5.1': { input: 10, output: 50 },
  'fable-5': { input: 10, output: 50 },
  'mythos-5.1': { input: 10, output: 50 },
  'opus-5.5': { input: 4, output: 20 },
  'opus-5': { input: 5, output: 25 },
  'opus-4.8': { input: 5, output: 25 },
  'opus-4.7': { input: 5, output: 25 },
  'opus-4.6': { input: 5, output: 25 },
  'sonnet-5.5': { input: 2, output: 10 },
  'sonnet-5': { input: 2, output: 10 },
  'sonnet-4.6': { input: 3, output: 15 },
  'haiku-5.5': { input: 0.1, output: 0.5 },
  'haiku-4.5': { input: 1, output: 5 },
};

/**
 * `claude-sonnet-5-5`, `anthropic/claude-sonnet-5.5`, `us.anthropic.claude-haiku-4-5-20251001-v1:0`, `claude-opus-5-5[1m]`
 * → `sonnet-5.5`, `sonnet-5.5`, `haiku-4.5`, `opus-5.5`. A date suffix is not a minor version (1–2 digits only).
 */
export function priceKey(model: string): string | null {
  const m = /(fable|mythos|opus|sonnet|haiku)-(\d+)(?:[-.](\d{1,2})(?!\d))?/.exec(model.toLowerCase());
  return m ? `${m[1]}-${m[2]}${m[3] ? `.${m[3]}` : ''}` : null;
}

export function priceOf(model: string): { input: number; output: number } | null {
  const key = priceKey(model);
  return (key && PRICES[key]) || null;
}

/** USD for these tokens, or null when the model is unknown. Zero tokens cost 0 even for an unknown model. */
export function costOf(model: string, inputTokens: number, outputTokens: number): number | null {
  if (!inputTokens && !outputTokens) return 0;
  const p = priceOf(model);
  return p ? (inputTokens * p.input + outputTokens * p.output) / 1e6 : null;
}
