/**
 * The two reducers over a {@link Manifest}. Both fold the line items into four
 * nano-USD subtotals — marked-up vs pass-through, fixed vs per-output-token —
 * and both apply the customer markup EXACTLY ONCE to the marked-up subtotal
 * (never per item, never to storage). `reservationCeiling` prices the run's
 * declared worst case (the admission hold, storage included per founder ruling);
 * `affordability` inverse-solves how many output tokens a balance can fund.
 */

import { MINIMUM_OUTPUT_TOKENS } from '../constants.js';
import { applyMarkup } from '../money.js';
import { nanoUSD, type NanoUSD } from '../nano-usd.js';
import type { Manifest } from './types.js';

interface Subtotals {
  /** Fixed cost that takes the markup (provider/model cost, web search). */
  fixedMarkedUp: bigint;
  /** Fixed cost that does not (pass-through storage). */
  fixedRaw: bigint;
  /** Per-output-token rate that takes the markup. */
  varMarkedUp: bigint;
  /** Per-output-token rate that does not. */
  varRaw: bigint;
}

function foldManifest(manifest: Manifest): Subtotals {
  const totals: Subtotals = { fixedMarkedUp: 0n, fixedRaw: 0n, varMarkedUp: 0n, varRaw: 0n };
  for (const item of manifest.items) {
    const fixed = item.fixedNano ?? 0n;
    const variable = item.variableOutputRateNano ?? 0n;
    if (item.marksUp) {
      totals.fixedMarkedUp += fixed;
      totals.varMarkedUp += variable;
    } else {
      totals.fixedRaw += fixed;
      totals.varRaw += variable;
    }
  }
  return totals;
}

/**
 * The pre-markup base cost of a manifest at a given output-token count:
 * `Σ fixed + outputTokens × Σ variableRate`. `marksUpOnly` selects which line
 * items fold in — `true` for the provider base settlement marks up (storage
 * excluded), `false` for the raw all-in total (storage included, e.g. the
 * trial 1¢ basis). NEVER applies the markup; callers wrap the marked-up subset
 * with {@link applyMarkup} downstream. One implementation of the fold both the
 * server run estimator and the trial cost basis reduce through.
 */
export function evaluateManifest(
  manifest: Manifest,
  outputTokens: bigint,
  options: { marksUpOnly: boolean }
): bigint {
  const { fixedMarkedUp, fixedRaw, varMarkedUp, varRaw } = foldManifest(manifest);
  const fixed = options.marksUpOnly ? fixedMarkedUp : fixedMarkedUp + fixedRaw;
  const variable = options.marksUpOnly ? varMarkedUp : varMarkedUp + varRaw;
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
 * worst case. The marked-up subtotal (model cost + ceiling×output rate) takes
 * the markup once; pass-through storage is added raw; the sum is multiplied by
 * width × steps × iterations. Storage is included in the hold so admission never
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

  const { fixedMarkedUp, fixedRaw, varMarkedUp, varRaw } = foldManifest(manifest);
  const markedUpSubtotal = fixedMarkedUp + input.outputTokenCeiling * varMarkedUp;
  const rawSubtotal = fixedRaw + input.outputTokenCeiling * varRaw;
  const perNode = applyMarkup(markedUpSubtotal) + rawSubtotal;
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
 * tokens can the balance fund? The marked-up fixed cost and marked-up per-token
 * rate each take the markup once (matching the fee-inclusive rate legacy carried
 * through per token); storage is added raw. A turn can send iff the balance
 * covers `fixed + MINIMUM_OUTPUT_TOKENS × rate`, at which point
 * `maxOutputTokens = floor((balance − fixed)/rate)`.
 */
export function affordability(manifest: Manifest, effectiveBalanceNano: bigint): Affordability {
  const { fixedMarkedUp, fixedRaw, varMarkedUp, varRaw } = foldManifest(manifest);

  const totalFixed = applyMarkup(fixedMarkedUp) + fixedRaw;
  const effectiveVariableRate = applyMarkup(varMarkedUp) + varRaw;
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
