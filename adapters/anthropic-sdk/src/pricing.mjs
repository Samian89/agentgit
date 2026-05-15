// Pricing table and cost estimator for Anthropic models.
// Hard-coded per-million-token rates (USD). Used by the adapter to populate
// costEstimateUsd on RecordedLlmCall / LlmCall records. Unknown models return null.
// Prices are intentionally conservative placeholders and easy to extend.

const PRICES = {
  "claude-opus-4-7": { inputPerM: 15.0, outputPerM: 75.0 },
  "claude-sonnet-4-6": { inputPerM: 3.0, outputPerM: 15.0 },
  "claude-haiku-4-5": { inputPerM: 0.25, outputPerM: 1.25 },
};

/**
 * Estimate USD cost for a given model and usage.
 * @param {string} model
 * @param {{promptTokens:number, completionTokens:number, totalTokens:number}|null} usage
 * @returns {number|null}
 */
export function estimateCost(model, usage) {
  if (!usage || typeof usage.promptTokens !== "number" || typeof usage.completionTokens !== "number") {
    return null;
  }
  const p = PRICES[model];
  if (!p) return null;
  const cost = (usage.promptTokens * p.inputPerM + usage.completionTokens * p.outputPerM) / 1_000_000;
  // Round to 6 decimal places to keep values stable and human-readable.
  return Math.round(cost * 1_000_000) / 1_000_000;
}
