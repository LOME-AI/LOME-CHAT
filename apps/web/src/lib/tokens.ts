/**
 * Estimate token count for text.
 * Uses a simple heuristic of ~4 characters per token.
 * This is an approximation - actual tokenization varies by model.
 */
export function estimateTokenCount(text: string): number {
  if (!text) return 0;
  // Rough estimate: ~4 characters per token
  return Math.ceil(text.length / 4);
}

/**
 * Format token count for display.
 * Uses K suffix for thousands, M suffix for millions.
 */
export function formatTokenCount(tokens: number): string {
  if (tokens >= 1000000) {
    const millions = tokens / 1000000;
    // Show decimal if not a whole number
    return millions % 1 === 0 ? `${String(millions)}M` : `${String(millions)}M`;
  }
  if (tokens >= 10000) {
    return `${String(Math.round(tokens / 1000))}k`;
  }
  return tokens.toLocaleString();
}

/**
 * Format context length for display.
 * Always uses K or M suffix since context lengths are typically large.
 */
export function formatContextLength(contextLength: number): string {
  if (contextLength >= 1000000) {
    return `${String(Math.round(contextLength / 1000000))}M`;
  }
  return `${String(Math.round(contextLength / 1000))}k`;
}
