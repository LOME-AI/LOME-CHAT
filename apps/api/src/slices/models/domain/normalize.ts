import { MODALITIES, callShapeFamilyFor, isRunnableModelShape } from '@hushbox/shared';
import { isNonConversational } from './non-chat-exclusions.js';
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
export type DescriptorContent = Omit<
  z.input<typeof ModelDescriptor>,
  'version' | 'fetchedAt' | 'popularityRank'
>;

/** Every reason a model is kept out of the catalog, in the order the refresh
 * summary lists them (quiet, expected exclusions first; the loud fail-closed
 * defects last). `unclassifiable-modality`, `unknown-pricing-unit`, and
 * `missing-release-date` are fail-closed defects that alert; `deprecated`,
 * `token-priced-image`, `token-priced-video`, `non-zdr` (only ZDR-reachable
 * models are persisted), `non-conversational` (specialty code-tooling and
 * moderation models — see `non-chat-exclusions.ts`), and `non-runnable-shape`
 * (a merged descriptor no turn can run — multi-output, or no text input — see
 * `isRunnableModelShape`) are expected shapes — counted, never paged.
 * Single-sources both the {@link ExcludeReason} union and the per-reason
 * summary breakdown. */
export const EXCLUDE_REASONS = [
  'token-priced-image',
  'token-priced-video',
  'megapixel-priced-image',
  'missing-pricing',
  'deprecated',
  'non-zdr',
  'non-conversational',
  'non-runnable-shape',
  'unclassifiable-modality',
  'missing-release-date',
  'unknown-pricing-unit',
] as const;

export type ExcludeReason = (typeof EXCLUDE_REASONS)[number];

export type NormalizeOutcome =
  | { kind: 'normalized'; content: DescriptorContent; pricingFallbacks?: readonly string[] }
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

/** The optional display-name spread: present only when the source carries one. */
function nameOf(model: GatewayModelMetadata): { name?: string } {
  return model.name === undefined ? {} : { name: model.name };
}

/** The optional description spread: present only when the source carries one. */
function descriptionOf(model: GatewayModelMetadata): { description?: string } {
  return model.description === undefined ? {} : { description: model.description };
}

/** The optional reasoning spread: present only when the gateway entry carried
 * a top-level reasoning object (absence stays absence in the persisted jsonb). */
function reasoningOf(model: LanguageMetadata): Pick<DescriptorContent, 'reasoning'> {
  return model.reasoning === undefined ? {} : { reasoning: model.reasoning };
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
  if (model.releasedAt === undefined || model.releasedAt <= 0) {
    return { kind: 'excluded', modelId: model.id, reason: 'missing-release-date' };
  }
  const content: DescriptorContent = {
    id: model.id,
    provider: model.provider,
    inputs: inputsOrText(model.inputModalities),
    outputs,
    releasedAt: model.releasedAt,
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
    ...nameOf(model),
    ...descriptionOf(model),
    ...reasoningOf(model),
  };
  return { kind: 'normalized', content };
}

// --- image -----------------------------------------------------------------

/** OpenRouter image billing units that price one output image. */
const PER_IMAGE_UNITS: ReadonlySet<string> = new Set(['image', 'per_image', 'per_output_image']);

type ImagePricingOutcome =
  | { readonly kind: 'priced'; readonly pricing: DescriptorContent['pricing'] }
  | { readonly kind: 'token' }
  | { readonly kind: 'megapixel' }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unknown' };

/**
 * Resolve an image model's output pricing. Only the `output_image` charge sets
 * the per-image rate; input-* roles (reference / text / image inputs) are never
 * the generation price and are ignored. Two KNOWN shapes we cannot price
 * deterministically exclude QUIETLY, never as fail-closed defects: per-output-
 * token pricing (`token`, a growing set of image models) and per-megapixel
 * pricing (`megapixel`, e.g. the flux.2 family). A model with no output pricing
 * rows at all (empty endpoints — common for preview models) is the quiet
 * `missing`. Only an output_image row carrying a genuinely unrecognized unit —
 * or a recognized per-image unit with an unparseable value — is the loud
 * `unknown`.
 */
interface ImagePricingScan {
  perImage: string | undefined;
  sawToken: boolean;
  sawMegapixel: boolean;
  sawUnknownUnit: boolean;
}

/** Classify one pricing entry into the running scan. Only `output_image` rows count. */
function scanImagePricingEntry(entry: ImagePricingEntry, scan: ImagePricingScan): void {
  if (entry.billable !== 'output_image') return;
  if (PER_IMAGE_UNITS.has(entry.unit)) {
    // First representable per-image rate wins; a recognized unit carrying an
    // unparseable value is a data defect, not a known shape — stays loud.
    const rate = usdRateToNanoUsd(entry.costUsd);
    if (rate === undefined) scan.sawUnknownUnit = true;
    else scan.perImage ??= rate;
  } else if (entry.unit.includes('token')) scan.sawToken = true;
  else if (entry.unit.includes('megapixel')) scan.sawMegapixel = true;
  else scan.sawUnknownUnit = true;
}

function imagePricing(entries: readonly ImagePricingEntry[]): ImagePricingOutcome {
  const scan: ImagePricingScan = {
    perImage: undefined,
    sawToken: false,
    sawMegapixel: false,
    sawUnknownUnit: false,
  };
  for (const entry of entries) scanImagePricingEntry(entry, scan);
  if (scan.perImage !== undefined) return { kind: 'priced', pricing: { perImage: scan.perImage } };
  if (scan.sawToken) return { kind: 'token' };
  if (scan.sawMegapixel) return { kind: 'megapixel' };
  if (scan.sawUnknownUnit) return { kind: 'unknown' };
  return { kind: 'missing' };
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
  if (model.releasedAt === undefined || model.releasedAt <= 0) {
    return { kind: 'excluded', modelId: model.id, reason: 'missing-release-date' };
  }
  const priced = imagePricing(model.endpointPricing);
  // Deterministic-only support: an image model we cannot price at admission or
  // settlement is excluded, never exposed unpriced. Token-priced, megapixel-
  // priced, and no-pricing (empty endpoints) are quiet, expected shapes;
  // anything else unrecognizable is the loud defect.
  if (priced.kind === 'token') {
    return { kind: 'excluded', modelId: model.id, reason: 'token-priced-image' };
  }
  if (priced.kind === 'megapixel') {
    return { kind: 'excluded', modelId: model.id, reason: 'megapixel-priced-image' };
  }
  if (priced.kind === 'missing') {
    return { kind: 'excluded', modelId: model.id, reason: 'missing-pricing' };
  }
  if (priced.kind === 'unknown') {
    return { kind: 'excluded', modelId: model.id, reason: 'unknown-pricing-unit' };
  }
  const content: DescriptorContent = {
    id: model.id,
    provider: model.provider,
    inputs: inputsOrText(model.inputModalities),
    outputs: ['image'],
    releasedAt: model.releasedAt,
    parameters: imageParameters(model.supportedParameters),
    behaviors: [],
    limits: {},
    pricing: priced.pricing,
    zdrReachable,
    ...nameOf(model),
    ...descriptionOf(model),
  };
  return { kind: 'normalized', content };
}

// --- video -----------------------------------------------------------------

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

interface VideoRate {
  /** `null` = flat: applies to any resolution the SKU set didn't price directly. */
  readonly resolution: string | null;
  readonly nano: string;
  readonly audio: boolean;
}

type VideoSkuOutcome =
  | { readonly kind: 'rate'; readonly rate: VideoRate }
  | { readonly kind: 'skip' }
  | { readonly kind: 'token' }
  | { readonly kind: 'unknown' };

/** A SKU key's role, read from its markers before rate parsing:
 * `video_tokens*` → token-priced; `*_input` / `image_to_video*` /
 * `*_without_audio*` → an unsupported tier we drop. `undefined` = a
 * per-second rate key to parse. */
function videoSkuMarker(key: string): 'token' | 'skip' | undefined {
  if (key.includes('video_tokens')) return 'token';
  if (key.includes('_input') || key.includes('image_to_video') || key.includes('_without_audio')) {
    return 'skip';
  }
  return undefined;
}

interface ParsedVideoRateKey {
  readonly unit: 'usd' | 'cents';
  /** `null` = flat (no resolution suffix). */
  readonly resolution: string | null;
  readonly audio: boolean;
}

/** Parse a per-second rate key: strip the `text_to_video_` mode prefix and the
 * `_with_audio` marker, read the unit prefix (`duration_seconds` = USD/sec,
 * `cents_per_video_output_second` = cents/sec), and take the resolution suffix
 * (empty → flat). An unrecognized unit returns `undefined` (→ unknown). */
function parseVideoRateKey(key: string): ParsedVideoRateKey | undefined {
  let rest = key;
  if (rest.startsWith('text_to_video_')) rest = rest.slice('text_to_video_'.length);
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
  const token = rest.replace(/^_/, '');
  return { unit, resolution: token.length > 0 ? token : null, audio };
}

/**
 * Classify one `pricing_skus` entry. Markers first (token / unsupported tier),
 * then a per-second `rate` (`duration_seconds[...]` USD or
 * `cents_per_video_output_second[...]` cents); an unrecognized unit is a
 * genuinely `unknown` unit (the fail-closed net for a novel taxonomy), and a
 * value that can't be represented in nano-USD is a silent `skip`.
 */
function classifyVideoSku(key: string, value: string): VideoSkuOutcome {
  const marker = videoSkuMarker(key);
  if (marker !== undefined) return { kind: marker };
  const parsed = parseVideoRateKey(key);
  if (parsed === undefined) return { kind: 'unknown' };
  const nano = usdRateToNanoUsd(parsed.unit === 'cents' ? centsToUsd(value) : value);
  if (nano === undefined) return { kind: 'skip' };
  return { kind: 'rate', rate: { resolution: parsed.resolution, nano, audio: parsed.audio } };
}

type VideoPricingResult =
  | {
      readonly kind: 'priced';
      readonly perSecondByResolution: Record<string, string>;
      readonly fallbacks: readonly string[];
    }
  | { readonly kind: 'empty' }
  | { readonly kind: 'token' }
  | { readonly kind: 'unknown' };

/** The rates a model states, keyed for the precedence lookup: resolution-specific
 * (case-normalized) with and without audio, plus the flat (resolution-less) rates. */
interface CollectedVideoRates {
  readonly resAudio: Map<string, string>;
  readonly resBare: Map<string, string>;
  flatAudio?: string;
  flatBare?: string;
  readonly allRates: string[];
}

/** Fold one parsed rate into the accumulator (audio wins its resolution; the
 * first bare rate wins a resolution/flat slot). */
function recordVideoRate(accumulator: CollectedVideoRates, rate: VideoRate): void {
  accumulator.allRates.push(rate.nano);
  if (rate.resolution === null) {
    if (rate.audio) accumulator.flatAudio = rate.nano;
    else accumulator.flatBare ??= rate.nano;
    return;
  }
  const norm = rate.resolution.toLowerCase();
  if (rate.audio) accumulator.resAudio.set(norm, rate.nano);
  else if (!accumulator.resBare.has(norm)) accumulator.resBare.set(norm, rate.nano);
}

/** Collect every SKU's rate, or reject the whole model on the first `token` /
 * `unknown` SKU (both make the model unpriceable-as-declared). */
function collectVideoRates(
  skus: Readonly<Record<string, string>>
): CollectedVideoRates | { readonly reject: 'token' | 'unknown' } {
  const accumulator: CollectedVideoRates = {
    resAudio: new Map(),
    resBare: new Map(),
    allRates: [],
  };
  for (const [key, value] of Object.entries(skus)) {
    const outcome = classifyVideoSku(key, value);
    if (outcome.kind === 'token' || outcome.kind === 'unknown') return { reject: outcome.kind };
    if (outcome.kind === 'rate') recordVideoRate(accumulator, outcome.rate);
  }
  return accumulator;
}

/** Largest of a non-empty set of nano-USD rate strings (bigint compare). */
function maxRate(rates: readonly string[]): string {
  let max = rates[0] ?? '0';
  for (const rate of rates) {
    if (BigInt(rate) > BigInt(max)) max = rate;
  }
  return max;
}

/** The rate for one declared resolution by fixed precedence — (a)
 * resolution-specific + audio, (b) resolution-specific, (c) flat + audio, (d)
 * flat — matching resolution tokens case-insensitively. */
function pickResolutionRate(rates: CollectedVideoRates, resolution: string): string | undefined {
  const norm = resolution.toLowerCase();
  return rates.resAudio.get(norm) ?? rates.resBare.get(norm) ?? rates.flatAudio ?? rates.flatBare;
}

/**
 * Build the per-resolution price matrix whose KEYS EXACTLY EQUAL the model's
 * declared `supported_resolutions` (case-preserved), so the estimator's strict
 * exact-key lookup can never miss. When a resolution has no stated rate but the
 * model prices some other resolution, its max known rate is SUBSTITUTED and
 * flagged (`fallbacks`): the one loud price-substitution, alerted for a human to
 * verify. A model with no usable rate at all for declared resolutions is
 * `unknown` (fail-closed); a model that declares no resolutions is `empty`
 * (unpriceable but exposed, degenerate).
 */
function interpretVideoSkus(
  resolutions: readonly string[],
  skus: Readonly<Record<string, string>>
): VideoPricingResult {
  const rates = collectVideoRates(skus);
  if ('reject' in rates) return rates.reject === 'token' ? { kind: 'token' } : { kind: 'unknown' };
  if (resolutions.length === 0) return { kind: 'empty' };
  if (rates.allRates.length === 0) return { kind: 'unknown' };
  const substitute = maxRate(rates.allRates);
  const perSecondByResolution: Record<string, string> = {};
  const fallbacks: string[] = [];
  for (const resolution of resolutions) {
    const rate = pickResolutionRate(rates, resolution);
    perSecondByResolution[resolution] = rate ?? substitute;
    if (rate === undefined) fallbacks.push(resolution);
  }
  return { kind: 'priced', perSecondByResolution, fallbacks };
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
  // Keyed `durationSeconds` (not `duration`) to match the request-parameter name
  // every consumer uses, and valued as integer seconds so a numeric request
  // duration matches the ParamSpec compiler's strict enum membership (the wire
  // catalog carries durations as strings). Non-integer/absent durations drop
  // out, mirroring the client-facing `supportedVideoDurationsSeconds` filter.
  const durationSeconds = model.durations
    .map(Number)
    .filter((seconds) => Number.isInteger(seconds) && seconds > 0);
  if (durationSeconds.length > 0) {
    specs['durationSeconds'] = { type: 'enum', values: durationSeconds, wire: 'providerOptions' };
  }
  if (model.generateAudio) specs['generateAudio'] = { type: 'boolean', wire: 'providerOptions' };
  if (model.seed) specs['seed'] = { type: 'integer', wire: 'providerOptions' };
  return specs;
}

function normalizeVideo(model: VideoMetadata, zdrReachable: boolean): NormalizeOutcome {
  if (model.releasedAt === undefined || model.releasedAt <= 0) {
    return { kind: 'excluded', modelId: model.id, reason: 'missing-release-date' };
  }
  const priced = interpretVideoSkus(model.resolutions, model.pricingSkus);
  if (priced.kind === 'token') {
    return { kind: 'excluded', modelId: model.id, reason: 'token-priced-video' };
  }
  if (priced.kind === 'unknown') {
    return { kind: 'excluded', modelId: model.id, reason: 'unknown-pricing-unit' };
  }
  const inputs: Modality[] = model.supportsFrameImages ? ['text', 'image'] : ['text'];
  const content: DescriptorContent = {
    id: model.id,
    provider: model.provider,
    inputs,
    outputs: ['video'],
    releasedAt: model.releasedAt,
    parameters: videoParameters(model),
    behaviors: [],
    limits: {},
    pricing:
      priced.kind === 'priced' ? { perSecondByResolution: priced.perSecondByResolution } : {},
    zdrReachable,
    ...nameOf(model),
    ...descriptionOf(model),
  };
  const fallbacks = priced.kind === 'priced' ? priced.fallbacks : [];
  return fallbacks.length > 0
    ? { kind: 'normalized', content, pricingFallbacks: fallbacks }
    : { kind: 'normalized', content };
}

/** The firm per-model gate, applied before family dispatch so it lives in one
 * family-agnostic place: only ZDR-reachable conversational models are
 * persisted. Non-ZDR wins first (the firm rule), then non-conversational
 * specialty models; `undefined` means the model passes to normalization. */
function nonChatExclusionReason(
  model: GatewayModelMetadata,
  zdrReachable: boolean
): ExcludeReason | undefined {
  if (!zdrReachable) return 'non-zdr';
  if (isNonConversational(model.id, model.provider, model.name)) return 'non-conversational';
  return undefined;
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
  const excludedReason = nonChatExclusionReason(model, zdrReachable);
  if (excludedReason !== undefined) {
    return { kind: 'excluded', modelId: model.id, reason: excludedReason };
  }
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

// --- dedupe + merge (one catalog, one row per id) --------------------------

/** One deduped catalog id: either a single merged descriptor or an exclusion.
 * The catalog is single-row-per-model (`model_catalog` UNIQUE(model_id)), so a
 * slug advertised by more than one endpoint must resolve to ONE descriptor —
 * not two rows racing to overwrite each other and oscillating between refreshes. */
export type CatalogEntry =
  | {
      readonly kind: 'normalized';
      readonly modelId: string;
      readonly content: DescriptorContent;
      /** Resolutions whose price was substituted (video fallback — §Solution 2a);
       * telemetry-only, never persisted. Present only when non-empty. */
      readonly pricingFallbacks?: readonly string[];
    }
  | { readonly kind: 'excluded'; readonly modelId: string; readonly reason: ExcludeReason };

/** Fixed merge order so a folded descriptor is identical no matter the order the
 * endpoints were fetched in — the property that kills refresh oscillation. The
 * language entry (richest: streaming, tool behaviors, token params) is the fold
 * base whenever present. */
const SOURCE_MERGE_PRIORITY: Readonly<Record<GatewayModelMetadata['source'], number>> = {
  language: 0,
  image: 1,
  video: 2,
};

/** Canonical order for language behaviors, so a merged behaviors list is stable
 * regardless of which sibling contributed each behavior. */
const LANGUAGE_BEHAVIOR_ORDER: readonly string[] = ['streaming', 'tools', 'reasoning'];

/** Union of two modality lists in the closed MODALITIES order (deterministic). */
function unionModalities(a: readonly Modality[], b: readonly Modality[]): Modality[] {
  const present = new Set<Modality>([...a, ...b]);
  return MODALITIES.filter((modality) => present.has(modality));
}

/** Behaviors recomputed against the MERGED outputs' family: language behaviors
 * (streaming, …) survive a text+media merge; a non-language merged family
 * carries none. Deterministic order regardless of sibling contribution order. */
function mergedBehaviors(
  outputs: readonly Modality[],
  a: readonly string[],
  b: readonly string[]
): string[] {
  if (callShapeFamilyFor(outputs) !== 'language') return [];
  const present = new Set<string>([...a, ...b]);
  const ordered = LANGUAGE_BEHAVIOR_ORDER.filter((behavior) => present.has(behavior));
  const extras = [...present]
    .filter((behavior) => !LANGUAGE_BEHAVIOR_ORDER.includes(behavior))
    .toSorted((x, y) => x.localeCompare(y));
  return [...ordered, ...extras];
}

/** Fold `next` into `base` (base takes precedence on scalar/key conflicts).
 * Outputs and inputs union; behaviors recompute against the merged outputs. */
function mergeContent(base: DescriptorContent, next: DescriptorContent): DescriptorContent {
  const outputs = unionModalities(base.outputs, next.outputs);
  const name = base.name ?? next.name;
  const description = base.description ?? next.description;
  // Only language sources carry reasoning, so at most one sibling declares it
  // — base precedence is deterministic regardless of contribution order.
  const reasoning = base.reasoning ?? next.reasoning;
  return {
    id: base.id,
    provider: base.provider,
    inputs: unionModalities(base.inputs, next.inputs),
    outputs,
    releasedAt: base.releasedAt,
    parameters: { ...next.parameters, ...base.parameters },
    behaviors: mergedBehaviors(outputs, base.behaviors, next.behaviors),
    limits: { ...next.limits, ...base.limits },
    pricing: { ...next.pricing, ...base.pricing },
    zdrReachable: base.zdrReachable,
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
    ...(reasoning === undefined ? {} : { reasoning }),
  };
}

/** A normalized catalog entry, carrying `pricingFallbacks` only when non-empty. */
function normalizedEntry(
  modelId: string,
  content: DescriptorContent,
  fallbacks: readonly string[]
): CatalogEntry {
  return fallbacks.length > 0
    ? { kind: 'normalized', modelId, content, pricingFallbacks: fallbacks }
    : { kind: 'normalized', modelId, content };
}

/** Resolve one id's siblings into a single entry: fold the normalized ones in
 * merge order; excluded only when every sibling is excluded (a normalized
 * sibling wins — the model is exposed via its merged form). */
function resolveGroup(
  modelId: string,
  siblings: readonly GatewayModelMetadata[],
  zdrModelIds: ReadonlySet<string>
): CatalogEntry {
  const ordered = siblings.toSorted(
    (a, b) => SOURCE_MERGE_PRIORITY[a.source] - SOURCE_MERGE_PRIORITY[b.source]
  );
  let content: DescriptorContent | undefined;
  let excludedReason: ExcludeReason | undefined;
  const fallbacks: string[] = [];
  for (const model of ordered) {
    const outcome = normalizeModel(model, zdrModelIds);
    if (outcome.kind === 'excluded') {
      excludedReason ??= outcome.reason;
      continue;
    }
    fallbacks.push(...(outcome.pricingFallbacks ?? []));
    content = content === undefined ? outcome.content : mergeContent(content, outcome.content);
  }
  if (content === undefined) {
    // A group always has ≥1 sibling, so with no normalized content a reason is set.
    return { kind: 'excluded', modelId, reason: excludedReason ?? 'deprecated' };
  }
  // Admission enforces the shared runnability predicate on the MERGED content:
  // a slug advertised across endpoints (e.g. /models + /images) folds to a
  // multi-output descriptor no turn can run — deny it here so "in catalog ⟺
  // runs correctly" holds, and it is never persisted.
  if (!isRunnableModelShape(content)) {
    return { kind: 'excluded', modelId, reason: 'non-runnable-shape' };
  }
  return normalizedEntry(modelId, content, fallbacks);
}

/**
 * Normalize a full catalog into one {@link CatalogEntry} per model id, merging
 * duplicate ids across endpoints into a single descriptor. The `model_catalog`
 * table is one-row-per-model, so a slug advertised by more than one endpoint
 * must resolve to ONE descriptor — not rows racing to overwrite each other and
 * oscillating between refreshes.
 */
export function normalizeCatalog(
  models: readonly GatewayModelMetadata[],
  zdrModelIds: ReadonlySet<string>
): CatalogEntry[] {
  const groups = new Map<string, GatewayModelMetadata[]>();
  const order: string[] = [];
  for (const model of models) {
    const existing = groups.get(model.id);
    if (existing === undefined) {
      groups.set(model.id, [model]);
      order.push(model.id);
    } else {
      existing.push(model);
    }
  }
  return order.map((modelId) => resolveGroup(modelId, groups.get(modelId) ?? [], zdrModelIds));
}
