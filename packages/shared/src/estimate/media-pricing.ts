/**
 * Media line items: the nano-USD, input-driven successor to legacy
 * `computeImageExactCents` / `computeVideoExactCents` / `computeAudioWorstCaseCents`.
 * A media generation prices as two components — provider generation cost and
 * output storage — both reproducing the legacy formula
 * `Σ(rate × units) + storageBytes × perByte × modelCount`:
 *
 *  - `media-generation` = per-model catalog rate × requested units, summed
 *    across models. Provider cost, so it MARKS UP (the reducer applies the
 *    markup once to the summed marked-up subtotal), mirroring legacy prices
 *    being fee-inclusive before storage was added.
 *  - `media-storage` = estimated output bytes × the media byte rate × model
 *    count. Pass-through storage — NEVER marked up.
 *
 * Image charges 1 unit (deterministic); video charges the resolution rate ×
 * duration; audio charges the flat per-second rate × the worst-case max
 * duration. `storageBytes` is a caller input (resolved from the modality byte
 * estimate), keeping the core input-driven. Fail-closed: a missing rate,
 * unpriceable resolution, or invalid parameter refuses before any provider
 * spend, never a silent zero.
 */

import { MEDIA_STORAGE_COST_PER_BYTE_NANO } from './storage-rate.js';
import { estimateErr, estimateOk } from './types.js';
import type {
  BillableRequest,
  EstimateResult,
  MediaBillable,
  ModelRatesNano,
  NanoLineItem,
} from './types.js';

/** A flat media rate (`perImage`/`perSecond`): rejects a dimension key. */
function resolveFlatRate(
  pricing: ModelRatesNano,
  rateKey: 'perImage' | 'perSecond',
  dimensionKey: string | undefined
): EstimateResult<bigint> {
  if (dimensionKey !== undefined) {
    return estimateErr(
      'invalid-request',
      `media rate '${rateKey}' is flat; no dimension key applies`
    );
  }
  const rate = rateKey === 'perImage' ? pricing.perImage : pricing.perSecond;
  if (typeof rate !== 'bigint') {
    return estimateErr('model-pricing-incomplete', `model pricing has no '${rateKey}' rate`);
  }
  return estimateOk(rate);
}

/**
 * The `perSecondByResolution` matrix rate. Requires a dimension key and resolves
 * the entry with an own-property guard so an inherited member (`constructor`,
 * `__proto__`) never resolves past the miss check.
 */
function resolveMatrixRate(
  pricing: ModelRatesNano,
  dimensionKey: string | undefined
): EstimateResult<bigint> {
  if (dimensionKey === undefined) {
    return estimateErr(
      'invalid-request',
      "media rate 'perSecondByResolution' is a matrix; a dimension key is required"
    );
  }
  const matrix = pricing.perSecondByResolution;
  if (matrix === undefined) {
    return estimateErr(
      'model-pricing-incomplete',
      "model pricing has no 'perSecondByResolution' rate"
    );
  }
  const rate = Object.prototype.hasOwnProperty.call(matrix, dimensionKey)
    ? matrix[dimensionKey]
    : undefined;
  if (typeof rate !== 'bigint') {
    return estimateErr(
      'model-pricing-incomplete',
      `model pricing 'perSecondByResolution' has no dimension '${dimensionKey}'`
    );
  }
  return estimateOk(rate);
}

/** Resolve one model's media rate, dispatching on the flat-vs-matrix rate key. */
function resolveMediaRate(pricing: ModelRatesNano, media: MediaBillable): EstimateResult<bigint> {
  return media.rateKey === 'perSecondByResolution'
    ? resolveMatrixRate(pricing, media.dimensionKey)
    : resolveFlatRate(pricing, media.rateKey, media.dimensionKey);
}

export function buildMediaLineItems(
  request: BillableRequest
): EstimateResult<readonly NanoLineItem[]> {
  const { models, media } = request;
  if (media === undefined) {
    return estimateErr('invalid-request', 'media request requires a media descriptor');
  }
  if (models.length === 0) {
    return estimateErr('invalid-request', 'at least one model is required');
  }
  if (!Number.isSafeInteger(media.units) || media.units < 1) {
    return estimateErr('invalid-request', 'media units must be a positive integer');
  }
  if (!Number.isSafeInteger(media.storageBytes) || media.storageBytes < 0) {
    return estimateErr('invalid-request', 'media storageBytes must be a non-negative integer');
  }

  let providerBase = 0n;
  for (const model of models) {
    const rate = resolveMediaRate(model.pricing, media);
    if (!rate.ok) return rate;
    providerBase += rate.value * BigInt(media.units);
  }

  const storageBase =
    BigInt(media.storageBytes) * MEDIA_STORAGE_COST_PER_BYTE_NANO * BigInt(models.length);

  return estimateOk([
    { label: 'media-generation', fixedNano: providerBase, marksUp: true },
    { label: 'media-storage', fixedNano: storageBase, marksUp: false },
  ]);
}
