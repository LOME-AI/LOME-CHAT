/**
 * Formatting utilities for consistent display across the application.
 * Single source of truth for number, cost, and context length formatting.
 */

import { nanoUsdToFullDollarString } from './nano-usd.js';

/**
 * Format a number with locale-specific thousand separators.
 *
 * @param num - The number to format
 * @returns Formatted string (e.g., "1,234,567")
 */
export function formatNumber(number_: number): string {
  return number_.toLocaleString();
}

/**
 * Format a context length (token count) for display.
 * Large numbers are abbreviated with K or M suffixes.
 *
 * @param length - Context length in tokens
 * @returns Formatted string (e.g., "128k", "1M")
 */
export function formatContextLength(length: number): string {
  if (length >= 1_000_000) {
    return `${String(Math.round(length / 1_000_000))}M`;
  }
  return `${String(Math.round(length / 1000))}k`;
}

/**
 * Format a price per 1000 tokens for display.
 * Strips trailing zeros for cleaner display.
 *
 * @param pricePerToken - Price per single token
 * @returns Formatted string (e.g., "$0.01")
 */
export function formatPricePer1k(pricePerToken: number): string {
  const pricePer1k = pricePerToken * 1000;
  const fixed = pricePer1k.toFixed(10);
  const stripped = fixed.replace(/\.?0+$/, '');
  return `$${stripped}`;
}

/**
 * Format a price range per 1000 tokens for display.
 *
 * @param minPricePerToken - Minimum price per single token
 * @param maxPricePerToken - Maximum price per single token
 * @returns Formatted string (e.g., "$0.0001 – $0.06 / 1k")
 */
export function formatPriceRange(minPricePerToken: number, maxPricePerToken: number): string {
  return `${formatPricePer1k(minPricePerToken)} – ${formatPricePer1k(maxPricePerToken)} / 1k`;
}

/**
 * Format a cost value for display.
 * Shows full precision (up to 8 decimals, matching database storage)
 * with trailing zeros stripped for clean display.
 *
 * @param cost - Cost as string or number
 * @returns Formatted string (e.g., "$0.00136")
 */
export function formatCost(cost: string | number): string {
  const numericCost = typeof cost === 'string' ? Number.parseFloat(cost) : cost;

  if (Number.isNaN(numericCost) || numericCost === 0) {
    return '$0.00';
  }

  const fixed = numericCost.toFixed(8);
  const stripped = fixed.replace(/\.?0+$/, '');
  return `$${stripped}`;
}

/**
 * Format a NanoUSD wire amount (as produced by `serializeNanoUSD`) for display
 * with sub-cent precision preserved. Settled per-message costs are sub-cent
 * (e.g. 1_360_000 nano = $0.00136); the cent-truncating nano formatters would
 * collapse those to "$0.00", so this bridges the nano-USD billing unit into
 * `formatCost`'s full-precision display via exact integer conversion — the raw
 * nano bigint is never `Number()`-coerced, so large amounts keep their
 * precision.
 *
 * @param wire - Canonical NanoUSD wire string
 * @returns Display string (e.g. "$0.00136", "$0.00" for zero)
 */
export function formatNanoUsdCost(wire: string): string {
  return formatCost(nanoUsdToFullDollarString(wire));
}

/**
 * Shorten a model name by removing version/date suffixes.
 * Removes patterns like:
 * - Date formats: -2024-08-06, -20240806
 * - Version numbers: -1-5, -1-2-3-4
 *
 * Preserves names like GPT-4 where the number is part of the model name.
 *
 * @param name - The model name to shorten
 * @returns Shortened model name with trailing date/version removed
 */
export function shortenModelName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    return '';
  }

  // Strip provider prefix (e.g., "anthropic/claude-3-5-sonnet" → "claude-3-5-sonnet")
  const slashIndex = trimmed.indexOf('/');
  const withoutProvider = slashIndex === -1 ? trimmed : trimmed.slice(slashIndex + 1);

  // Pattern matches trailing date/version suffixes:
  // - Single group with 4+ digits (e.g., -20240806)
  // - Multiple groups of digits (e.g., -2024-08-06, -1-5)
  // Does NOT match single-digit suffixes like GPT-4
  const versionDatePattern = /-(\d{4,}|\d{1,10}(-\d{1,10})+)$/;

  return withoutProvider.replace(versionDatePattern, '');
}

export const CHAT_TITLE_MAX_LENGTH = 50;
export const DEFAULT_CHAT_TITLE = 'New Conversation';

export function generateChatTitle(firstMessageContent?: string): string {
  if (!firstMessageContent) {
    return DEFAULT_CHAT_TITLE;
  }
  return firstMessageContent.slice(0, CHAT_TITLE_MAX_LENGTH);
}
