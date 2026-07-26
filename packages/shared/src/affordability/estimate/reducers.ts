/**
 * The two reducers over a {@link Manifest}. Both fold the line items into four
 * nano-USD subtotals — provider vs storage, fixed vs per-output-token — as
 * pure sums: every rate in a manifest is already BILLABLE (fees are baked at
 * the catalog-ingestion seam), so no fee math exists here or anywhere in the
 * estimator. `reservationCeiling` prices the run's declared worst case (the
 * admission hold, storage included per founder ruling); `affordability`
 * inverse-solves how many output tokens a balance can fund.
 */

import { MINIMUM_OUTPUT_TOKENS } from '../constants.js';
import { nanoUSD, type NanoUSD } from '../nano-usd.js';
import type { Manifest } from './types.js';

interface Subtotals {
  /** Fixed provider cost (model/media inference, web search, classifier). */
  fixedProvider: bigint;
  /** Fixed pass-through storage cost. */
  fixedStorage: bigint;
  /** Per-output-token provider rate. */
  varProvider: bigint;
  /** Per-output-token pass-through storage rate. */
  varStorage: bigint;
}

function foldManifest(manifest: Manifest): Subtotals {
  const totals: Subtotals = {
    fixedProvider: 0n,
    fixedStorage: 0n,
    varProvider: 0n,
    varStorage: 0n,
  };
  for (const item of manifest.items) {
    const fixed = item.fixedNano ?? 0n;
    const variable = item.variableOutputRateNano ?? 0n;
    if (item.kind === 'provider') {
      totals.fixedProvider += fixed;
      totals.varProvider += variable;
    } else {
      totals.fixedStorage += fixed;
      totals.varStorage += variable;
    }
  }
  return totals;
}

/**
 * The billable cost of a manifest at a given output-token count:
 * `Σ fixed + outputTokens × Σ variableRate`. `scope` selects which line items
 * fold in — `'provider-only'` for the provider subtotal (storage excluded),
 * `'all-in'` for the full total (storage included, e.g. the trial 1¢ basis).
 * One implementation of the fold both the server run estimator and the trial
 * cost basis reduce through.
 */
export function evaluateManifest(
  manifest: Manifest,
  outputTokens: bigint,
  options: { scope: 'provider-only' | 'all-in' }
): bigint {
  const { fixedProvider, fixedStorage, varProvider, varStorage } = foldManifest(manifest);
  const fixed = options.scope === 'provider-only' ? fixedProvider : fixedProvider + fixedStorage;
  const variable = options.scope === 'provider-only' ? varProvider : varProvider + varStorage;
  return fixed + outputTokens * variable;
}

function requirePositiveIntegerMultiplier(label: string, value: number): bigint {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`reservationCeiling: ${label} must be a positive integer`);
  }
  return BigInt(value);
}

export interface ReservationCeilingInput {
  /** The declared worst-case output tokens a single node execution may emit. */
  outputTokenCeiling: bigint;
  /** Declared fan-out width. */
  fanOutWidth: number;
  /** Declared maximum steps. */
  maxSteps: number;
  /** Declared maximum loop iterations. */
  maxIterations: number;
}

/**
 * The admission hold: per-node ceiling cost priced across the run's declared
 * worst case — `(Σ fixed + ceiling × Σ variableRate)` over every folded item,
 * multiplied by width × steps × iterations. Rates are billable, so the hold is
 * `≥` any settlement charge for the same manifest at an actual output count
 * within the ceiling. Storage is included in the hold so admission never
 * under-reserves relative to settlement.
 */
export function reservationCeiling(manifest: Manifest, input: ReservationCeilingInput): NanoUSD {
  if (input.outputTokenCeiling < 0n) {
    throw new RangeError('reservationCeiling: outputTokenCeiling must be non-negative');
  }
  const multiplier =
    requirePositiveIntegerMultiplier('fanOutWidth', input.fanOutWidth) *
    requirePositiveIntegerMultiplier('maxSteps', input.maxSteps) *
    requirePositiveIntegerMultiplier('maxIterations', input.maxIterations);

  const { fixedProvider, fixedStorage, varProvider, varStorage } = foldManifest(manifest);
  const perNode =
    fixedProvider + fixedStorage + input.outputTokenCeiling * (varProvider + varStorage);
  return nanoUSD(perNode * multiplier);
}

export interface Affordability {
  /** Whether the balance covers the minimum-viable turn. */
  canSend: boolean;
  /** The most output tokens the balance can fund (0 when it cannot send). */
  maxOutputTokens: bigint;
  /** Minimum cost of a turn, gated on MINIMUM_OUTPUT_TOKENS, in nano-USD. */
  minCostNano: bigint;
  /** Why the turn is denied, when it is. */
  denialReason?: string;
}

/**
 * Inverse solve: given a manifest and an effective balance, how many output
 * tokens can the balance fund? Provider and storage subtotals sum directly —
 * every rate is already billable. A turn can send iff the balance covers
 * `fixed + MINIMUM_OUTPUT_TOKENS × rate`, at which point
 * `maxOutputTokens = floor((balance − fixed)/rate)`.
 */
export function affordability(manifest: Manifest, effectiveBalanceNano: bigint): Affordability {
  const { fixedProvider, fixedStorage, varProvider, varStorage } = foldManifest(manifest);

  const totalFixed = fixedProvider + fixedStorage;
  const effectiveVariableRate = varProvider + varStorage;
  if (effectiveVariableRate <= 0n) {
    throw new RangeError('affordability: manifest has no positive per-output-token rate');
  }

  const minCostNano = totalFixed + BigInt(MINIMUM_OUTPUT_TOKENS) * effectiveVariableRate;
  const canSend = effectiveBalanceNano >= minCostNano;
  if (!canSend) {
    return {
      canSend: false,
      maxOutputTokens: 0n,
      minCostNano,
      denialReason: 'insufficient_balance',
    };
  }
  // Positive numerator (balance ≥ minCost ≥ fixed), so bigint division floors.
  const maxOutputTokens = (effectiveBalanceNano - totalFixed) / effectiveVariableRate;
  return { canSend: true, maxOutputTokens, minCostNano };
}
