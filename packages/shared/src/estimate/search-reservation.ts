/**
 * The web-search worst-case reservation as a {@link NanoLineItem}. A text turn
 * with the search tool enabled reserves `MAX_SEARCH_TOOL_CALLS` invocations at
 * the conservative per-call rate, per model — the nano-USD, input-driven
 * successor to legacy `worstCaseSearchCost()` (`applyFees(MAX_SEARCH_TOOL_CALLS ×
 * SEARCH_COST_PER_CALL)`), summed `× modelCount`. Search is a provider cost, so
 * the item MARKS UP; the reducer applies the markup once to the summed marked-up
 * subtotal. Settlement bills the provider's actual search cost (folded into
 * `usage.cost`), never this reservation.
 */

import { MAX_SEARCH_TOOL_CALLS, SEARCH_COST_PER_CALL } from '../constants.js';
import { usdToNanoUsd } from '../money.js';
import type { NanoLineItem } from './types.js';

/**
 * One model's worst-case web-search reservation in BASE (pre-markup) nano-USD:
 * `MAX_SEARCH_TOOL_CALLS × SEARCH_COST_PER_CALL`. Single-sourced from the shared
 * search constants so the reservation can never drift from the runtime cap.
 */
export const WEB_SEARCH_RESERVATION_BASE_NANO_PER_MODEL: bigint =
  BigInt(MAX_SEARCH_TOOL_CALLS) * usdToNanoUsd(SEARCH_COST_PER_CALL);

/**
 * The web-search reservation line item for a turn across `modelCount` models.
 * `modelCount` is always a validated positive integer from the calling request;
 * a non-positive value is a caller invariant break, thrown like the reducers'
 * multiplier guards.
 */
export function webSearchLineItem(modelCount: number): NanoLineItem {
  if (!Number.isSafeInteger(modelCount) || modelCount < 1) {
    throw new RangeError('webSearchLineItem: modelCount must be a positive integer');
  }
  return {
    label: 'web-search-reservation',
    fixedNano: WEB_SEARCH_RESERVATION_BASE_NANO_PER_MODEL * BigInt(modelCount),
    marksUp: true,
  };
}
