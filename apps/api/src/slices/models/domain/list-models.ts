import {
  PROVIDER_MAP,
  SMART_MODEL_ID,
  modelSchema,
  nanoUSD,
  serializeNanoUSD,
} from '@hushbox/shared';
import { dispatchFamilyFor } from './dispatch.js';
import { listDescriptors } from './list-descriptors.js';
import { isTextModel, trialEligibility } from './trial-eligibility.js';
import type {
  Model,
  ModelDescriptor,
  ModelsListResponse,
  Pricing,
  WireModelPricing,
} from '@hushbox/shared';
import type { ListDescriptorsDeps } from './list-descriptors.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';

/**
 * The public catalog projection: exposed descriptors → the shared
 * `ModelsListResponse` wire contract (`Model[]` + `premiumModelIds`) the web
 * picker and the marketing site consume. Pricing is projected as BASE
 * (pre-markup) integer nano-USD rates, verbatim from the descriptor `Pricing`
 * — no fee, no markup. The canonical cost estimator applies the 15% markup
 * exactly once downstream; shipping the raw rate keeps that the single seam.
 */

/** A flat named rate as a bigint, or undefined when absent or a matrix rate. */
function flatRate(pricing: Pricing, key: string): bigint | undefined {
  const rate = pricing[key];
  return typeof rate === 'bigint' ? rate : undefined;
}

/** A BASE nano rate as its canonical wire string, or undefined when absent. */
function nanoString(rate: bigint | undefined): string | undefined {
  return rate === undefined ? undefined : serializeNanoUSD(nanoUSD(rate));
}

// bigint min/max: `Math.min`/`Math.max` would coerce to double and lose
// nano-USD precision, so the extrema are found by comparison. Callers pass a
// non-empty pool; the `0n` seed only satisfies the type.
function minBigint(values: readonly bigint[]): bigint {
  let lowest = values[0] ?? 0n;
  for (const value of values) if (value < lowest) lowest = value;
  return lowest;
}

function maxBigint(values: readonly bigint[]): bigint {
  let highest = values[0] ?? 0n;
  for (const value of values) if (value > highest) highest = value;
  return highest;
}

/**
 * Display provider + name, matching the legacy split: an OpenRouter display
 * name like "Google: Gemini 2.5 Pro" carries its provider before the colon;
 * otherwise the descriptor's provider slug maps through `PROVIDER_MAP` (the
 * slug itself is the fallback — more informative than legacy's 'Unknown').
 */
function providerAndName(descriptor: ModelDescriptor): { provider: string; name: string } {
  const raw = descriptor.name;
  if (raw !== undefined) {
    const colonIndex = raw.indexOf(':');
    if (colonIndex > 0) {
      const provider = raw.slice(0, colonIndex).trim();
      const name = raw.slice(colonIndex + 1).trim();
      if (provider.length > 0 && name.length > 0) return { provider, name };
    }
  }
  return {
    provider: PROVIDER_MAP[descriptor.provider] ?? descriptor.provider,
    name: raw ?? descriptor.id,
  };
}

/** Enum ParamSpec values as display strings, or undefined when absent. */
function enumValues(descriptor: ModelDescriptor, key: string): string[] | undefined {
  const spec = descriptor.parameters[key];
  if (spec?.type !== 'enum' || spec.values === undefined) return undefined;
  return spec.values.map(String);
}

/** Enum ParamSpec values as positive integers (video durations), or undefined. */
function enumIntegers(descriptor: ModelDescriptor, key: string): number[] | undefined {
  const spec = descriptor.parameters[key];
  if (spec?.type !== 'enum' || spec.values === undefined) return undefined;
  const integers = spec.values
    .map((value) => (typeof value === 'number' ? value : Number(value)))
    .filter((value) => Number.isInteger(value) && value > 0);
  return integers.length > 0 ? integers : undefined;
}

/**
 * BASE nano pricing for a descriptor, carrying ONLY its own modality's rate
 * dimension so the schema's modality-pricing refinement holds even for merged
 * multi-output descriptors carrying foreign pricing keys. An absent rate is
 * omitted (undefined), never zero-filled — a missing required rate makes the
 * schema drop the row (fail-closed on unpriceable models).
 */
function modalityPricing(descriptor: ModelDescriptor, family: ListedFamily): WireModelPricing {
  if (family === 'language') {
    return {
      inputPerToken: nanoString(flatRate(descriptor.pricing, 'inputPerToken')),
      outputPerToken: nanoString(flatRate(descriptor.pricing, 'outputPerToken')),
    };
  }
  if (family === 'image') {
    return { perImage: nanoString(flatRate(descriptor.pricing, 'perImage')) };
  }
  const byResolution = descriptor.pricing['perSecondByResolution'];
  if (typeof byResolution !== 'object') return {};
  return {
    perSecondByResolution: Object.fromEntries(
      Object.entries(byResolution).map(([resolution, rate]) => [
        resolution,
        serializeNanoUSD(nanoUSD(rate)),
      ])
    ),
  };
}

/** Optional capability-list spreads sourced from the descriptor's ParamSpecs. */
function capabilityLists(
  descriptor: ModelDescriptor,
  family: ListedFamily
): Partial<
  Pick<
    Model,
    'supportedAspectRatios' | 'supportedVideoResolutions' | 'supportedVideoDurationsSeconds'
  >
> {
  if (family === 'language') return {};
  const aspectRatios = enumValues(descriptor, 'aspectRatio');
  const resolutions = family === 'video' ? enumValues(descriptor, 'resolution') : undefined;
  const durations = family === 'video' ? enumIntegers(descriptor, 'durationSeconds') : undefined;
  return {
    ...(aspectRatios === undefined ? {} : { supportedAspectRatios: aspectRatios }),
    ...(resolutions === undefined ? {} : { supportedVideoResolutions: resolutions }),
    ...(durations === undefined ? {} : { supportedVideoDurationsSeconds: durations }),
  };
}

const MODALITY_BY_FAMILY = { language: 'text', image: 'image', video: 'video' } as const;

/** The families the list serves (embedding stays hidden — no adapter ships). */
type ListedFamily = keyof typeof MODALITY_BY_FAMILY;

/** One descriptor → a shared-contract `Model` candidate (unvalidated). */
function wireCandidate(descriptor: ModelDescriptor, family: ListedFamily): unknown {
  const { provider, name } = providerAndName(descriptor);
  const contextLength = family === 'language' ? (descriptor.limits['contextLength'] ?? 0) : 0;
  return {
    id: descriptor.id,
    name,
    provider,
    modality: MODALITY_BY_FAMILY[family],
    contextLength,
    pricing: modalityPricing(descriptor, family),
    capabilities: [],
    description: descriptor.description ?? name,
    supportedParameters: [...descriptor.behaviors, ...Object.keys(descriptor.parameters)],
    created: descriptor.releasedAt,
    ...capabilityLists(descriptor, family),
    ...(descriptor.popularityRank === undefined
      ? {}
      : { popularityRank: descriptor.popularityRank }),
    ...(descriptor.reasoning === undefined ? {} : { reasoning: descriptor.reasoning }),
  };
}

/** A descriptor the Smart Model price range (and pool) can be computed over. */
function isPriceableTextDescriptor(descriptor: ModelDescriptor): boolean {
  return (
    isTextModel(descriptor) &&
    flatRate(descriptor.pricing, 'inputPerToken') !== undefined &&
    flatRate(descriptor.pricing, 'outputPerToken') !== undefined
  );
}

/**
 * The synthetic Smart Model entry — a virtual list row the UI can select; the
 * backend resolves the real model per message. Headline prices track the
 * cheapest pool model (the real lower bound); min/max carry the display range.
 */
function smartModelCandidate(pool: readonly ModelDescriptor[]): unknown {
  // Pool membership is gated by `isPriceableTextDescriptor`, so every entry
  // carries both flat per-token rates; `?? 0n` only narrows the type.
  const inputRates = pool.map((entry) => flatRate(entry.pricing, 'inputPerToken') ?? 0n);
  const outputRates = pool.map((entry) => flatRate(entry.pricing, 'outputPerToken') ?? 0n);
  const contexts = pool.map((entry) => entry.limits['contextLength'] ?? 0);
  const minInput = minBigint(inputRates);
  const minOutput = minBigint(outputRates);
  return {
    id: SMART_MODEL_ID,
    name: 'Smart Model',
    provider: 'HushBox',
    modality: 'text',
    contextLength: Math.max(...contexts),
    // Headline pricing tracks the cheapest pool model (the real lower bound);
    // min/max carry the BASE nano display range.
    pricing: {
      inputPerToken: serializeNanoUSD(nanoUSD(minInput)),
      outputPerToken: serializeNanoUSD(nanoUSD(minOutput)),
    },
    capabilities: [],
    description: 'Automatically picks the best model for each message.',
    supportedParameters: [],
    isSmartModel: true,
    minPricing: {
      inputPerToken: serializeNanoUSD(nanoUSD(minInput)),
      outputPerToken: serializeNanoUSD(nanoUSD(minOutput)),
    },
    maxPricing: {
      inputPerToken: serializeNanoUSD(nanoUSD(maxBigint(inputRates))),
      outputPerToken: serializeNanoUSD(nanoUSD(maxBigint(outputRates))),
    },
  };
}

/**
 * The list-level premium classification (legacy `processModels` semantics):
 * a text model is premium exactly when the trial gate would refuse it as
 * `premium` (top price quartile OR recent release OR minimal-exchange
 * unaffordability — the one shared predicate, so the list and the paid tier
 * gate never disagree); every non-text model is premium (media modalities
 * require an account, mirroring legacy's all-media-premium ids).
 */
function isPremiumListed(
  descriptor: ModelDescriptor,
  exposedCatalog: readonly ModelDescriptor[],
  nowMs: number
): boolean {
  if (!isTextModel(descriptor)) return true;
  const verdict = trialEligibility(descriptor, exposedCatalog, nowMs);
  return !verdict.eligible && verdict.reason === 'premium';
}

export interface WireCatalog {
  readonly response: ModelsListResponse;
  /** Model ids whose wire projection failed the shared contract (hidden). */
  readonly dropped: readonly string[];
}

/** The validated Smart Model rows (none when no priceable text pool exists). */
function smartModelRows(descriptors: readonly ModelDescriptor[], dropped: string[]): Model[] {
  const pool = descriptors.filter((entry) => isPriceableTextDescriptor(entry));
  if (pool.length === 0) return [];
  const parsed = modelSchema.safeParse(smartModelCandidate(pool));
  if (!parsed.success) {
    dropped.push(SMART_MODEL_ID);
    return [];
  }
  return [parsed.data];
}

/**
 * Exposed descriptors → the wire response. Legacy list order is preserved:
 * text models, then the synthetic Smart Model entry, then media models. A
 * projection that fails the shared `modelSchema` is dropped (hidden is the
 * safe failure mode — one bad row never takes down the list); the schema
 * parse also strips anything beyond the shared contract.
 */
export function buildModelsListResponse(
  descriptors: readonly ModelDescriptor[],
  nowMs: number
): WireCatalog {
  const textModels: Model[] = [];
  const mediaModels: Model[] = [];
  const premiumModelIds: string[] = [];
  const dropped: string[] = [];

  for (const descriptor of descriptors) {
    const family = dispatchFamilyFor(descriptor);
    if (family === undefined || family === 'embedding') {
      dropped.push(descriptor.id);
      continue;
    }
    const parsed = modelSchema.safeParse(wireCandidate(descriptor, family));
    if (!parsed.success) {
      dropped.push(descriptor.id);
      continue;
    }
    (family === 'language' ? textModels : mediaModels).push(parsed.data);
    if (isPremiumListed(descriptor, descriptors, nowMs)) premiumModelIds.push(descriptor.id);
  }

  return {
    response: {
      models: [...textModels, ...smartModelRows(descriptors, dropped), ...mediaModels],
      premiumModelIds,
    },
    dropped,
  };
}

/**
 * The route-facing read: the exposed catalog (`listDescriptors`' ZDR- and
 * exposure-filtered set — nothing hidden there can reappear here) projected
 * to the wire contract, alerting on any projection drop.
 */
export function listModels(
  deps: ListDescriptorsDeps,
  nowMs: number
): ResultAsync<ModelsListResponse, DomainError> {
  return listDescriptors(deps).map((descriptors) => {
    const { response, dropped } = buildModelsListResponse(descriptors, nowMs);
    for (const modelId of dropped) {
      deps.telemetry.error('model failed wire projection — hidden from the list', {
        modelName: modelId,
        errorCode: 'model_projection_invalid',
      });
    }
    return response;
  });
}
