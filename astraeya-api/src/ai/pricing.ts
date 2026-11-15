/**
 * What each model tier costs, in US dollars per million tokens, for the usage
 * reports. Prices are Anthropic's first-party rates (cached 2026-11-03). Cache
 * writes are taken as 1.25x input, and Lotus's cache reads as a tenth of
 * input; both are estimates, marked as such where they are shown.
 */

export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const MODEL_PRICES: Record<string, ModelPrice> = {
  // Athena 2.5 (claude-opus-5-5)
  advanced: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  // Metis 3.0 (claude-sonnet-5-5)
  standard: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  // Lotus (claude-haiku-5-5), prompts up to 100K tokens
  quick: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
};

export interface TokenTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Estimated cost in US dollars; 0 for models with no price here (local models). */
export function estimateCost(model: string | null, t: TokenTotals): number {
  const p = model ? MODEL_PRICES[model] : undefined;
  if (!p) return 0;
  const dollars =
    (t.inputTokens * p.input + t.outputTokens * p.output + t.cacheReadTokens * p.cacheRead + t.cacheWriteTokens * p.cacheWrite) /
    1_000_000;
  return Math.round(dollars * 10_000) / 10_000;
}
