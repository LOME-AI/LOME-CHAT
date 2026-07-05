import { MODALITIES, callShapeFamilyFor } from '@hushbox/shared';
import { usdRateToNanoUsd } from './usd-rate.js';
import type { Modality, ModelDescriptor, ParamSpec as ParameterSpec } from '@hushbox/shared';
import type {
  GatewayModelMetadata,
  ImageMetadata,
  ImagePricingEntry,
  ImageSupportedParameters,
  LanguageMetadata,
  LanguageTokenPricing,
  VideoMetadata,
} from './gateway-metadata.js';
import type { z } from 'zod';

/**
 * Descriptor content: the wire form of `ModelDescriptor` minus the fields
 * stamped at persist time (`version`, `fetchedAt`). Skip-unchanged
 * content-compares exactly this shape — a refresh that changes nothing
 * here writes nothing.
 */
export type DescriptorContent = Omit<z.input<typeof ModelDescriptor>, 'version' | 'fetchedAt'>;

/** Why a model is kept out of the catalog. `unclassifiable-modality` and
 * `unknown-pricing-unit` are fail-closed defects that alert; `deprecated` is
 * expected lifecycle and never pages. */
export type ExcludeReason = 'unclassifiable-modality' | 'unknown-pricing-unit' | 'deprecated';

export type NormalizeOutcome =
  | { kind: 'normalized'; content: DescriptorContent }
  | { kind: 'excluded'; modelId: string; reason: ExcludeReason };

/**
 * OpenRouter `supported_parameters` names → canonical descriptor ParamSpecs
 * for language models. Data, not per-model code: a name missing here is
 * skipped (the model still works with defaults). Canonical names match the
 * SDK call-shape the adapters wire.
 */
const SUPPORTED_PARAMETER_SPECS: Readonly<
  Record<string, { readonly name: string; readonly spec: ParameterSpec }>
> = {
  temperature: {
    name: 'temperature',
    spec: { type: 'number', min: 0, max: 2, wire: 'firstClass' },
  },
  top_p: { name: 'topP', spec: { type: 'number', min: 0, max: 1, wire: 'firstClass' } },
  max_output_tokens: {
    name: 'maxOutputTokens',
    spec: { type: 'integer', min: 1, wire: 'firstClass' },
  },
};

/** Gateway parameter names that signal behaviors rather than call params. */
const BEHAVIOR_PARAMETERS: Readonly<Record<string, string>> = {
  tools: 'tools',
  reasoning: 'reasoning',
};

const MODALITY_SET: ReadonlySet<string> = new Set(MODALITIES);

function knownModalities(values: readonly string[]): Modality[] {
  return values.filter((value): value is Modality => MODALITY_SET.has(value));
}

function seedParameters(supportedParameters: readonly string[]): Record<string, ParameterSpec> {
  const parameters: Record<string, ParameterSpec> = {};
  for (const gatewayName of supportedParameters) {
    const known = SUPPORTED_PARAMETER_SPECS[gatewayName];
    if (known !== undefined) parameters[known.name] = known.spec;
  }
  return parameters;
}

function languageBehaviors(supportedParameters: readonly string[]): string[] {
  const behaviors = ['streaming'];
  for (const gatewayName of supportedParameters) {
    const behavior = BEHAVIOR_PARAMETERS[gatewayName];
    if (behavior !== undefined) behaviors.push(behavior);
  }
  return behaviors;
}

function tokenPricing(pricing: LanguageTokenPricing | undefined): DescriptorContent['pricing'] {
  if (pricing === undefined) return {};
  const entries: [string, string | undefined][] = [
    ['inputPerToken', pricing.prompt === undefined ? undefined : usdRateToNanoUsd(pricing.prompt)],
    [
      'outputPerToken',
      pricing.completion === undefined ? undefined : usdRateToNanoUsd(pricing.completion),
    ],
    [
      'cachedInputPerToken',
      pricing.cacheRead === undefined ? undefined : usdRateToNanoUsd(pricing.cacheRead),
    ],
  ];
  const result: DescriptorContent['pricing'] = {};
  for (const [key, value] of entries) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function inputsOrText(values: readonly string[]): Modality[] {
  const known = knownModalities(values);
  return known.length > 0 ? known : ['text'];
}

// --- language --------------------------------------------------------------

function normalizeLanguage(model: LanguageMetadata, zdrReachable: boolean): NormalizeOutcome {
  if (model.deprecated) {
    return { kind: 'excluded', modelId: model.id, reason: 'deprecated' };
  }
  const outputs = knownModalities(model.outputModalities);
  if (callShapeFamilyFor(outputs) === undefined) {
    return { kind: 'excluded', modelId: model.id, reason: 'unclassifiable-modality' };
  }
  const content: DescriptorContent = {
    id: model.id,
    provider: model.provider,
    inputs: inputsOrText(model.inputModalities),
    outputs,
    parameters: seedParameters(model.supportedParameters),
    // Behaviors key off the canonical family of the FINAL outputs: a
    // text→media entry (file-part outputs, no text) is media-classified by
    // exposure gating and dispatch, so it carries media behaviors (none
    // today), never streaming/language.
    behaviors:
      callShapeFamilyFor(outputs) === 'language'
        ? languageBehaviors(model.supportedParameters)
        : [],
    limits: model.contextLength === undefined ? {} : { contextLength: model.contextLength },
    pricing: tokenPricing(model.pricing),
    zdrReachable,
  };
  return { kind: 'normalized', content };
}

// --- image -----------------------------------------------------------------

/** OpenRouter image billing units that price one output image. */
const PER_IMAGE_UNITS: ReadonlySet<string> = new Set(['image', 'per_image', 'per_output_image']);

/** OpenRouter image billing unit → descriptor pricing key. An unrecognized
 * unit leaves the model unpriced (hidden), never crashes. */
function imagePricingKey(unit: string): string | undefined {
  return PER_IMAGE_UNITS.has(unit) ? 'perImage' : undefined;
}

function imagePricing(entries: readonly ImagePricingEntry[]): DescriptorContent['pricing'] {
  const pricing: Record<string, string> = {};
  for (const entry of entries) {
    if (!entry.billable) continue;
    const key = imagePricingKey(entry.unit);
    if (key === undefined) continue;
    const nano = usdRateToNanoUsd(entry.costUsd);
    if (nano !== undefined) pricing[key] = nano;
  }
  return pricing;
}

function imageParameters(params: ImageSupportedParameters): Record<string, ParameterSpec> {
  const specs: Record<string, ParameterSpec> = {};
  if (params.aspectRatio.length > 0) {
    specs['aspectRatio'] = {
      type: 'enum',
      values: [...params.aspectRatio],
      wire: 'providerOptions',
    };
  }
  if (params.resolution.length > 0) {
    specs['resolution'] = { type: 'enum', values: [...params.resolution], wire: 'providerOptions' };
  }
  if (params.maxN !== undefined) {
    specs['n'] = { type: 'integer', min: 1, max: params.maxN, wire: 'providerOptions' };
  }
  return specs;
}

function normalizeImage(model: ImageMetadata, zdrReachable: boolean): NormalizeOutcome {
  const content: DescriptorContent = {
    id: model.id,
    provider: model.provider,
    inputs: inputsOrText(model.inputModalities),
    outputs: ['image'],
    parameters: imageParameters(model.supportedParameters),
    behaviors: [],
    limits: {},
    pricing: imagePricing(model.endpointPricing),
    zdrReachable,
  };
  return { kind: 'normalized', content };
}

// --- video -----------------------------------------------------------------

interface ParsedVideoSku {
  readonly unit: 'usd' | 'cents';
  readonly resolution: string;
  readonly audio: boolean;
}

/** OpenRouter video `pricing_skus` keys are heterogeneous. Recognized shapes:
 * `duration_seconds[_<res>]` (USD/sec), `cents_per_video_output_second[_<res>]`
 * (CENTS/sec), each optionally `_with_audio`. An unrecognized key is an
 * unknown unit — the model is excluded fail-closed, never guessed. */
function parseVideoSku(key: string): ParsedVideoSku | undefined {
  let rest = key;
  let audio = false;
  if (rest.includes('_with_audio')) {
    audio = true;
    rest = rest.replace('_with_audio', '');
  }
  let unit: 'usd' | 'cents';
  if (rest.startsWith('cents_per_video_output_second')) {
    unit = 'cents';
    rest = rest.slice('cents_per_video_output_second'.length);
  } else if (rest.startsWith('duration_seconds')) {
    unit = 'usd';
    rest = rest.slice('duration_seconds'.length);
  } else {
    return undefined;
  }
  const resolution = rest.replace(/^_/, '') || 'default';
  return { unit, resolution, audio };
}

/** Shift a decimal USD-cents string two places right of the point:
 * "5" → "0.05", "5.5" → "0.055", "123" → "1.23" — exact string math. */
function centsToUsd(cents: string): string {
  const dot = cents.indexOf('.');
  const whole = dot === -1 ? cents : cents.slice(0, dot);
  const fraction = dot === -1 ? '' : cents.slice(dot + 1);
  const digits = whole + fraction;
  const pointPos = whole.length - 2;
  if (pointPos <= 0) return `0.${'0'.repeat(-pointPos)}${digits}`;
  return `${digits.slice(0, pointPos)}.${digits.slice(pointPos)}`;
}

type VideoPricingResult =
  | { readonly ok: true; readonly pricing: DescriptorContent['pricing'] }
  | { readonly ok: false };

type VideoSkuOutcome =
  | {
      readonly kind: 'rate';
      readonly resolution: string;
      readonly nano: string;
      readonly audio: boolean;
    }
  | { readonly kind: 'skip' }
  | { readonly kind: 'unknown' };

/** One SKU → a resolved per-second rate, `skip` (value unrepresentable), or
 * `unknown` (unrecognized unit → the caller excludes the model). */
function resolveVideoSku(key: string, value: string): VideoSkuOutcome {
  const parsed = parseVideoSku(key);
  if (parsed === undefined) return { kind: 'unknown' };
  const nano = usdRateToNanoUsd(parsed.unit === 'cents' ? centsToUsd(value) : value);
  if (nano === undefined) return { kind: 'skip' };
  return { kind: 'rate', resolution: parsed.resolution, nano, audio: parsed.audio };
}

function interpretVideoSkus(skus: Readonly<Record<string, string>>): VideoPricingResult {
  const byResolution: Record<string, string> = {};
  const audioByResolution: Record<string, string> = {};
  for (const [key, value] of Object.entries(skus)) {
    const rate = resolveVideoSku(key, value);
    if (rate.kind === 'unknown') return { ok: false };
    if (rate.kind === 'skip') continue;
    // HushBox always requests audio, so an audio-inclusive rate wins its
    // resolution; a bare rate only fills a resolution audio hasn't priced.
    if (rate.audio) audioByResolution[rate.resolution] = rate.nano;
    else byResolution[rate.resolution] ??= rate.nano;
  }
  const perSecondByResolution: Record<string, string> = { ...byResolution, ...audioByResolution };
  if (Object.keys(perSecondByResolution).length === 0) return { ok: true, pricing: {} };
  return { ok: true, pricing: { perSecondByResolution } };
}

function videoParameters(model: VideoMetadata): Record<string, ParameterSpec> {
  const specs: Record<string, ParameterSpec> = {};
  if (model.resolutions.length > 0) {
    specs['resolution'] = { type: 'enum', values: [...model.resolutions], wire: 'providerOptions' };
  }
  if (model.aspectRatios.length > 0) {
    specs['aspectRatio'] = {
      type: 'enum',
      values: [...model.aspectRatios],
      wire: 'providerOptions',
    };
  }
  if (model.durations.length > 0) {
    specs['duration'] = { type: 'enum', values: [...model.durations], wire: 'providerOptions' };
  }
  if (model.generateAudio) specs['generateAudio'] = { type: 'boolean', wire: 'providerOptions' };
  if (model.seed) specs['seed'] = { type: 'integer', wire: 'providerOptions' };
  return specs;
}

function normalizeVideo(model: VideoMetadata, zdrReachable: boolean): NormalizeOutcome {
  const pricing = interpretVideoSkus(model.pricingSkus);
  if (!pricing.ok) {
    return { kind: 'excluded', modelId: model.id, reason: 'unknown-pricing-unit' };
  }
  const inputs: Modality[] = model.supportsFrameImages ? ['text', 'image'] : ['text'];
  const content: DescriptorContent = {
    id: model.id,
    provider: model.provider,
    inputs,
    outputs: ['video'],
    parameters: videoParameters(model),
    behaviors: [],
    limits: {},
    pricing: pricing.pricing,
    zdrReachable,
  };
  return { kind: 'normalized', content };
}

/**
 * OpenRouter metadata → versionless descriptor content. `zdrReachable` is
 * authoritative endpoint-granular membership in `/endpoints/zdr` by model id;
 * unlisted is treated as unreachable and hidden (fail-closed). Modalities
 * come from `architecture.*_modalities` (language) or the endpoint the model
 * was discovered on (image/video).
 */
export function normalizeModel(
  model: GatewayModelMetadata,
  zdrModelIds: ReadonlySet<string>
): NormalizeOutcome {
  const zdrReachable = zdrModelIds.has(model.id);
  switch (model.source) {
    case 'language': {
      return normalizeLanguage(model, zdrReachable);
    }
    case 'image': {
      return normalizeImage(model, zdrReachable);
    }
    case 'video': {
      return normalizeVideo(model, zdrReachable);
    }
  }
}
