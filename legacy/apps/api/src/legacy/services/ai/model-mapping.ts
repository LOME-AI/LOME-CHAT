import { isZdrModel, type RawModel } from '@hushbox/shared/models';
import { applyFees, parseTokenPrice, assertNever } from '@hushbox/shared';
import type { ModelInfo, ModelPricing } from './types.js';

/**
 * Map a fully-merged RawModel (output of shared `fetchModels`, which merges
 * the SDK `/config` endpoint with the public `/v1/models` endpoint for media
 * pricing) to the AIClient-layer ModelInfo shape.
 *
 * Fee contract: every `ModelInfo.pricing.*` price field is fee-inclusive —
 * fees are applied once inside `pricingFromRawModel`. This matches the
 * contract for `Model.pricePer*` (see `process-models.ts`) so downstream
 * billing math (`computeImageExactCents`, `computeVideoExactCents`, etc.)
 * never needs to re-apply fees regardless of which Model-like view the
 * price came from.
 *
 * Lives in its own module so both `real.ts` and `mock.ts` derive ModelInfo
 * the same way, keeping one source of truth for the raw → info translation.
 * Pulling it through `real.ts` would force `mock.ts` to transitively load the
 * AI SDK at module-eval time.
 */
export function rawModelToModelInfo(raw: RawModel): ModelInfo {
  // `String.split('/')[0]` always returns a string at runtime, so `??` would
  // never fire. The explicit length check also catches rogue models with an
  // empty id, surfacing them as `'unknown'` instead of an empty provider.
  const segment = raw.id.split('/')[0];
  const provider = segment !== undefined && segment.length > 0 ? segment : 'unknown';
  return {
    id: raw.id,
    name: raw.name,
    provider,
    modality: raw.modality,
    description: raw.description,
    contextLength: raw.context_length,
    pricing: pricingFromRawModel(raw),
    capabilities: [],
    isZdr: isZdrModel(raw.id, raw.modality),
  };
}

function pricingFromRawModel(raw: RawModel): ModelPricing {
  switch (raw.modality) {
    case 'text': {
      const ws = raw.pricing.web_search;
      // Web-search-per-call is a raw constant — fees applied at billing time
      // via `applyFees(webSearchCost)` in pricing.ts. Keep it raw here so the
      // billing pipeline can charge it correctly.
      const webSearchPerCall = ws === undefined ? undefined : parseTokenPrice(ws);
      return {
        kind: 'token',
        inputPerToken: applyFees(parseTokenPrice(raw.pricing.prompt)),
        outputPerToken: applyFees(parseTokenPrice(raw.pricing.completion)),
        ...(webSearchPerCall === undefined ? {} : { webSearchPerCall }),
      };
    }
    case 'image': {
      const rawPerImage = raw.pricing.per_image;
      return {
        kind: 'image',
        perImage: rawPerImage === undefined ? 0 : applyFees(parseTokenPrice(rawPerImage)),
      };
    }
    case 'video': {
      const rawMap = raw.pricing.per_second_by_resolution ?? {};
      const perSecondByResolution = Object.fromEntries(
        Object.entries(rawMap).map(([res, price]) => [res, applyFees(parseTokenPrice(price))])
      );
      return { kind: 'video', perSecondByResolution };
    }
    case 'audio': {
      // Audio pricing extraction is deferred until the AI Gateway ships ZDR
      // audio (ZDR_AUDIO_MODEL_IDS is `[] as const` in `zdr.ts`). Adding the
      // catalog extractor today would be speculative since the public
      // `/v1/models` endpoint doesn't carry audio entries; we'd guess the
      // field name without a real example. When audio ships:
      //   1. Add the ZDR audio model id to `ZDR_AUDIO_MODEL_IDS`.
      //   2. Add an `extractAudioPricing` to `packages/shared/src/models/fetch.ts`
      //      mirroring `extractImagePricing` against the real catalog key.
      //   3. Replace this `0` with `applyFees(parseTokenPrice(raw.pricing.per_second ?? '0'))`.
      // Mocks override `pricing.perSecond` on the ModelInfo for billing tests
      // — those overrides must use fee-inclusive prices to stay consistent.
      return { kind: 'audio', perSecond: 0 };
    }
    default: {
      return assertNever(raw.modality);
    }
  }
}
