/**
 * `priceRequest` builds a nano-USD {@link Manifest} for a billable request. It
 * dispatches on `modality` (absent ⇒ text): the TEXT/token path sums per-model
 * input and output rates plus input/output storage; the media path prices
 * generation + storage line items. On top of the modality base it folds the
 * fixed web-search reservation (when `webSearch`) and the Smart-Model classifier
 * pre-reserve (when `classifierStage`). It applies NO fee math (rates arrive
 * billable from the catalog) and does NO char→token conversion — conversion
 * lives in the pre-adapters. This is the nano-USD, input-driven successor to legacy
 * `buildCostManifest`.
 */

import { classifierLineItems } from './classifier-line-item.js';
import { buildMediaLineItems } from './media-pricing.js';
import { webSearchLineItem } from './search-reservation.js';
import { STORAGE_COST_PER_CHARACTER_NANO } from './storage-rate.js';
import { estimateErr, estimateOk } from './types.js';
import type { BillableRequest, EstimateResult, Manifest, NanoLineItem } from './types.js';

function isNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Sum a per-token rate across models, failing closed if any model lacks it. A
 * text request charges every model for the same input tokens and every model's
 * output, so the rates add.
 */
function sumRate(
  models: BillableRequest['models'],
  key: 'inputPerToken' | 'outputPerToken'
): EstimateResult<bigint> {
  let sum = 0n;
  for (const model of models) {
    const rate = model.pricing[key];
    if (typeof rate !== 'bigint') {
      return estimateErr('model-pricing-incomplete', `model pricing has no '${key}' rate`);
    }
    sum += rate;
  }
  return estimateOk(sum);
}

/** The text/token base line items: per-model rates summed, plus storage. */
function buildTextLineItems(request: BillableRequest): EstimateResult<readonly NanoLineItem[]> {
  const { models, inputTokens, inputChars, outputCharsPerToken } = request;

  if (inputTokens < 0n) {
    return estimateErr('invalid-request', 'inputTokens must be non-negative');
  }
  if (!isNonNegativeInteger(inputChars)) {
    return estimateErr('invalid-request', 'inputChars must be a non-negative integer');
  }
  if (!Number.isSafeInteger(outputCharsPerToken) || outputCharsPerToken < 1) {
    return estimateErr('invalid-request', 'outputCharsPerToken must be a positive integer');
  }

  const inputRate = sumRate(models, 'inputPerToken');
  if (!inputRate.ok) return inputRate;
  const outputRate = sumRate(models, 'outputPerToken');
  if (!outputRate.ok) return outputRate;

  const modelCount = BigInt(models.length);

  return estimateOk([
    {
      label: 'text-input-tokens',
      fixedNano: inputTokens * inputRate.value,
      kind: 'provider',
    },
    {
      label: 'input-storage',
      fixedNano: BigInt(inputChars) * STORAGE_COST_PER_CHARACTER_NANO,
      kind: 'storage',
    },
    {
      label: 'text-output-tokens',
      variableOutputRateNano: outputRate.value,
      kind: 'provider',
    },
    {
      label: 'output-storage',
      variableOutputRateNano:
        BigInt(outputCharsPerToken) * STORAGE_COST_PER_CHARACTER_NANO * modelCount,
      kind: 'storage',
    },
  ]);
}

export function priceRequest(request: BillableRequest): EstimateResult<Manifest> {
  const { models, modality } = request;

  if (models.length === 0) {
    return estimateErr('invalid-request', 'at least one model is required');
  }

  if (modality === 'embedding') {
    return estimateErr('invalid-request', 'embedding modality is not priceable by the estimator');
  }
  const base =
    modality === undefined || modality === 'text'
      ? buildTextLineItems(request)
      : buildMediaLineItems(request);
  if (!base.ok) return base;

  const items: NanoLineItem[] = [...base.value];

  if (request.webSearch === true) {
    items.push(webSearchLineItem(models.length));
  }

  if (request.classifierStage !== undefined) {
    const classifier = classifierLineItems(request.classifierStage, request.outputCharsPerToken);
    if (!classifier.ok) return classifier;
    items.push(...classifier.value);
  }

  return estimateOk({ items });
}
