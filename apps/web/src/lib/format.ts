/**
 * Format context length for display.
 * Examples: 128000 → "128k", 1000000 → "1M"
 */
export function formatContextLength(length: number): string {
  if (length >= 1000000) {
    return `${String(Math.round(length / 1000000))}M`;
  }
  return `${String(Math.round(length / 1000))}k`;
}

/**
 * Format price per token to price per 1k tokens, without trailing zeros.
 * Examples: 0.00001 → "$0.01", 0.000003 → "$0.003"
 */
export function formatPricePer1k(pricePerToken: number): string {
  const pricePer1k = pricePerToken * 1000;
  // Show more precision for very small prices, then strip trailing zeros
  let fixed: string;
  if (pricePer1k < 0.001) {
    fixed = pricePer1k.toFixed(6);
  } else if (pricePer1k < 0.01) {
    fixed = pricePer1k.toFixed(4);
  } else if (pricePer1k < 1) {
    fixed = pricePer1k.toFixed(3);
  } else {
    fixed = pricePer1k.toFixed(2);
  }
  // Strip trailing zeros by parsing and converting back
  return `$${String(parseFloat(fixed))}`;
}
