// Pricing estimates for Vercel AI SDK routed models.
// Returns per-million-token USD prices (input/output) for known models;
// estimateCost computes the cost from usage or returns null for unknown models.
// The table is intentionally small and conservative; extend as needed.

const MODEL_PRICES = {
  "openai/gpt-4o": { input: 2.5, output: 10.0 },
  "openai/gpt-4o-mini": { input: 0.15, output: 0.6 },
  "anthropic/claude-3-5-sonnet-20241022": { input: 3.0, output: 15.0 },
  "anthropic/claude-3-opus-20240229": { input: 15.0, output: 75.0 },
};

/**
 * Estimate cost in USD for a model + usage.
 * @param {string} model
 * @param {{promptTokens:number, completionTokens:number}|null|undefined} usage
 * @returns {number|null}
 */
export function estimateCost(model, usage) {
  if (!model || !usage) return null;
  const prompt = Number(usage.promptTokens ?? usage.inputTokens ?? 0);
  const completion = Number(usage.completionTokens ?? usage.outputTokens ?? 0);
  if (!Number.isFinite(prompt) || !Number.isFinite(completion)) return null;

  let prices = MODEL_PRICES[model];
  if (!prices && typeof model === "string" && model.startsWith("anthropic/claude-")) {
    // Fallback for any anthropic/claude-* routed via Vercel
    prices = MODEL_PRICES["anthropic/claude-3-5-sonnet-20241022"];
  }
  if (!prices) return null;

  const cost = (prompt * prices.input + completion * prices.output) / 1_000_000;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

export { MODEL_PRICES };
