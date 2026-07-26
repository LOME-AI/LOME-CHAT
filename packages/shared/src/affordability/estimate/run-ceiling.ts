/**
 * The admission run-ceiling estimator, hoisted from the product Worker so it is
 * the ONE priced-worst-case implementation both the server admission path and
 * the client affordability preflight reduce through. Every cost formula (the
 * per-token/media manifest, the billable-sum ceiling reducer) already lives in
 * this package's estimator core; this module maps a catalog `Pricing` bag into
 * the core's `ModelRatesNano` and drives the `priceRequest` /
 * `buildMediaLineItems` / `reservationCeiling` reducers, surfacing failures on
 * the shared {@link EstimateResult} channel (shared has no neverthrow — the
 * server re-maps this to its own `Result` at the boundary).
 */

import { buildMediaLineItems } from './media-pricing.js';
import { priceRequest } from './price-request.js';
import { reservationCeiling } from './reducers.js';
import { estimateErr, estimateOk } from './types.js';
import type { ReservationCeilingInput } from './reducers.js';
import type {
  EstimateResult,
  Manifest,
  MediaBillable,
  MediaRateKey,
  ModelRatesNano,
} from './types.js';
import type { Pricing } from '../model-descriptor.js';

/** One priced call's usage: token counts, or a media rate key with its units. */
export type CallUsage =
  | { readonly kind: 'tokens'; readonly inputTokens: number; readonly outputTokens: number }
  | {
      readonly kind: 'media';
      /** The catalog pricing key to charge against (`perImage`, `perSecond`, or the matrix). */
      readonly rateKey: MediaRateKey;
      /** Required when the rate is a per-resolution matrix. */
      readonly dimensionKey?: string;
      readonly units: number;
    };

/** The declared ceiling admission prices: max width × steps × iterations. */
export interface DeclaredCeiling {
  readonly maxFanOutWidth: number;
  readonly maxSteps: number;
  readonly maxIterations: number;
}

/**
 * The per-node storage inputs a persisting turn adds to its ceiling. Absent ⇒
 * provider cost only (the pre-storage default for general workflows and the
 * settlement-side base pricers). Input storage is NOT here — it is charged once
 * at the definition level by the run estimator, not per node.
 */
export interface NodeStorage {
  /** Output-storage chars-per-token for the tier (answer-producing token nodes). */
  readonly outputCharsPerToken: number;
  /** Estimated encrypted output bytes (media nodes). */
  readonly mediaStorageBytes: number;
}

/** Storage OFF: the base/ceiling pricers price provider cost only. */
export const NO_STORAGE: NodeStorage = { outputCharsPerToken: 1, mediaStorageBytes: 0 };

/**
 * Reads the catalog `Pricing` bag into the core's named-rate shape. A missing or
 * wrong-typed key is simply left off — the core fails closed on the specific rate
 * a request needs, so an omitted rate becomes a precise pricing error there rather
 * than a silent zero here.
 */
export function ratesFromPricing(pricing: Pricing): ModelRatesNano {
  const rates: {
    inputPerToken?: bigint;
    outputPerToken?: bigint;
    perImage?: bigint;
    perSecond?: bigint;
    perSecondByResolution?: Readonly<Record<string, bigint>>;
  } = {};
  const input = pricing['inputPerToken'];
  if (typeof input === 'bigint') rates.inputPerToken = input;
  const output = pricing['outputPerToken'];
  if (typeof output === 'bigint') rates.outputPerToken = output;
  const perImage = pricing['perImage'];
  if (typeof perImage === 'bigint') rates.perImage = perImage;
  const perSecond = pricing['perSecond'];
  if (typeof perSecond === 'bigint') rates.perSecond = perSecond;
  const matrix = pricing['perSecondByResolution'];
  if (matrix !== undefined && typeof matrix !== 'bigint') rates.perSecondByResolution = matrix;
  return rates;
}

/** The output-token count a token usage emits; media has no token output leg. */
export function outputTokensOf(usage: CallUsage): bigint {
  return usage.kind === 'tokens' ? BigInt(usage.outputTokens) : 0n;
}

function countError(value: number, label: string): EstimateResult<bigint> {
  if (!Number.isSafeInteger(value) || value < 0) {
    return estimateErr('invalid-request', `Estimate ${label} must be a non-negative integer`);
  }
  return estimateOk(BigInt(value));
}

/**
 * One call's billable {@link Manifest} from the core. The token path prices
 * per-model input/output rates plus an output-storage rate item; the media path
 * prices `rate × units` plus a media-storage item. Input storage is always zero
 * here (`inputChars: 0`) — it is a definition-level, not per-call, cost. With
 * {@link NO_STORAGE} the storage items are zero/discarded and only provider cost
 * survives.
 */
export function callManifest(
  pricing: Pricing,
  usage: CallUsage,
  storage: NodeStorage
): EstimateResult<Manifest> {
  const rates = ratesFromPricing(pricing);
  if (usage.kind === 'tokens') {
    const inputTokens = countError(usage.inputTokens, 'inputTokens');
    if (!inputTokens.ok) return inputTokens;
    const outputTokens = countError(usage.outputTokens, 'outputTokens');
    if (!outputTokens.ok) return outputTokens;
    return priceRequest({
      models: [{ pricing: rates }],
      inputTokens: inputTokens.value,
      inputChars: 0,
      outputCharsPerToken: storage.outputCharsPerToken,
    });
  }
  const billable: MediaBillable = {
    rateKey: usage.rateKey,
    ...(usage.dimensionKey === undefined ? {} : { dimensionKey: usage.dimensionKey }),
    units: usage.units,
    storageBytes: storage.mediaStorageBytes,
  };
  const items = buildMediaLineItems({
    models: [{ pricing: rates }],
    inputTokens: 0n,
    inputChars: 0,
    outputCharsPerToken: storage.outputCharsPerToken,
    media: billable,
  });
  if (!items.ok) return items;
  return estimateOk({ items: items.value });
}

/** A manifest reduced to its provider items — pass-through storage stripped. */
function providerOnly(manifest: Manifest): Manifest {
  return { items: manifest.items.filter((item) => item.kind === 'provider') };
}

/**
 * Builds the core's `ReservationCeilingInput` from the declared ceiling and a
 * call's output-token count, validating each dimension is a positive integer.
 * The core reducer throws on an invalid multiplier (a caller invariant break);
 * validating here keeps a bad declaration on the fail-closed result channel — a
 * refused run, never a thrown defect.
 */
function ceilingInput(
  usage: CallUsage,
  ceiling: DeclaredCeiling
): EstimateResult<ReservationCeilingInput> {
  const dimensions: readonly (readonly [string, number])[] = [
    ['maxFanOutWidth', ceiling.maxFanOutWidth],
    ['maxSteps', ceiling.maxSteps],
    ['maxIterations', ceiling.maxIterations],
  ];
  for (const [label, value] of dimensions) {
    if (!Number.isSafeInteger(value) || value < 1) {
      return estimateErr('invalid-request', `Estimate ceiling ${label} must be a positive integer`);
    }
  }
  return estimateOk({
    outputTokenCeiling: outputTokensOf(usage),
    fanOutWidth: ceiling.maxFanOutWidth,
    maxSteps: ceiling.maxSteps,
    maxIterations: ceiling.maxIterations,
  });
}

/**
 * The admission estimate: the per-call ceiling cost priced across the run's
 * declared worst case, via the core `reservationCeiling` reducer (a pure sum
 * over billable rates, multiplied by width × steps × iterations). With
 * `storage` present the node's output-storage (token nodes) or media-storage
 * (media nodes) rides the ceiling; absent, only provider cost is priced. A
 * zero ceiling is rejected — it would place a zero admission hold (free
 * admission), which is always a caller bug, never a legitimate run.
 */
export function estimateRunCeilingNanoUsd(
  pricing: Pricing,
  usage: CallUsage,
  ceiling: DeclaredCeiling,
  storage?: NodeStorage
): EstimateResult<bigint> {
  const manifest = callManifest(pricing, usage, storage ?? NO_STORAGE);
  if (!manifest.ok) return manifest;
  const input = ceilingInput(usage, ceiling);
  if (!input.ok) return input;
  const priced = storage === undefined ? providerOnly(manifest.value) : manifest.value;
  const amount = reservationCeiling(priced, input.value);
  if (amount === 0n) {
    return estimateErr('invalid-request', 'Estimate run ceiling must be a positive amount');
  }
  return estimateOk(amount);
}
