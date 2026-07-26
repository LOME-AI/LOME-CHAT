/**
 * The web-search worst-case reservation as a {@link NanoLineItem}. A text turn
 * with the search tool enabled reserves `MAX_SEARCH_TOOL_CALLS` invocations at
 * the conservative per-call rate, per model — the nano-USD, input-driven
 * successor to legacy `worstCaseSearchCost()`, summed `× modelCount`. Search is
 * a provider cost; unlike catalog rates (baked billable at ingestion), the
 * per-call constant is a raw provider figure, so the billable reservation is
 * baked ONCE here at definition (ceil, against the user — the same seam rule as
 * ingestion), never at estimate time. Settlement bills the provider's actual
 * search cost (folded into `usage.cost`, made billable at the port), never this
 * reservation.
 */

import { MAX_SEARCH_TOOL_CALLS, SEARCH_COST_PER_CALL } from '../constants.js';
import { applyMarkupCeil, usdToNanoUsd } from '../money.js';
import type { NanoLineItem } from './types.js';

/**
 * One model's worst-case web-search reservation, BILLABLE at definition: the
 * provider base (`MAX_SEARCH_TOOL_CALLS × SEARCH_COST_PER_CALL`, single-sourced
 * from the shared search constants so the reservation can never drift from the
 * runtime cap) with the customer markup baked exactly once, ceil-rounded
 * (over-reserve, matching catalog rate baking). This is the figure estimate
 * manifests AND the server admission worst case carry, so no consumer holds
 * fee logic.
 */
export const WEB_SEARCH_RESERVATION_NANO_PER_MODEL: bigint = applyMarkupCeil(
  BigInt(MAX_SEARCH_TOOL_CALLS) * usdToNanoUsd(SEARCH_COST_PER_CALL)
);

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
    fixedNano: WEB_SEARCH_RESERVATION_NANO_PER_MODEL * BigInt(modelCount),
    kind: 'provider',
  };
}
