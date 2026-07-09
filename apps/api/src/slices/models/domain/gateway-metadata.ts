import { z } from 'zod';
import { unavailableError, validationError } from '../../../lib/errors/index.js';
import { ResultAsync, errAsync, fromPromise, okAsync } from '../../../lib/result/index.js';
import type { DomainError } from '../../../lib/errors/index.js';

/**
 * OpenRouter catalog discovery. Four public endpoints (no API key):
 *   `/models`         — language + multimodal models (modalities, pricing,
 *                       flat supported_parameters, deprecation).
 *   `/endpoints/zdr`  — the authoritative, endpoint-granular ZDR set;
 *                       `zdrReachable` is membership by `model_id`.
 *   `/images/models`  — image models; per-model pricing is fetched N+1 from
 *                       `/images/models/{id}/endpoints`.
 *   `/videos/models`  — video models; pricing lives in a heterogeneous
 *                       `pricing_skus` dict (see the normalizer's interpreter).
 *
 * SYNTHETIC-CONTRACT NOTE: implementation agents hold no credentials, so the
 * wire shapes below are authored from OpenRouter's documented metadata
 * format and exercised only through injected fixtures — the typed
 * `GatewayCatalog` seam consumed by normalization is what stays stable.
 */

// --- /models (language + multimodal) ---------------------------------------

const modelsPricingSchema = z.looseObject({
  prompt: z.string().optional(),
  completion: z.string().optional(),
  input_cache_read: z.string().optional(),
});

const modelsEntrySchema = z.looseObject({
  id: z.string().min(1),
  name: z.string().optional(),
  description: z.string().nullish(),
  // Model creation timestamp, UNIX SECONDS. Carried through to the descriptor's
  // required `releasedAt`; a model missing it is excluded at normalization.
  created: z.number().nullish(),
  context_length: z.number().nullish(),
  architecture: z
    .looseObject({
      input_modalities: z.array(z.string()).nullish(),
      output_modalities: z.array(z.string()).nullish(),
    })
    .nullish(),
  pricing: modelsPricingSchema.nullish(),
  supported_parameters: z.array(z.string()).nullish(),
  expiration_date: z.string().nullish(),
});

const modelsResponseSchema = z.looseObject({ data: z.array(modelsEntrySchema) });

// --- /endpoints/zdr (authoritative ZDR membership) -------------------------

const zdrResponseSchema = z.looseObject({
  data: z.array(z.looseObject({ model_id: z.string().min(1) })),
});

// --- /images/models --------------------------------------------------------

/** Structured image parameter surface (resolution / aspect_ratio / n / …). */
const imageSupportedParametersSchema = z
  .looseObject({
    resolution: z.array(z.string()).nullish(),
    aspect_ratio: z.array(z.string()).nullish(),
    n: z.looseObject({ min: z.number().optional(), max: z.number().optional() }).nullish(),
  })
  .nullish();

const imagesEntrySchema = z.looseObject({
  id: z.string().min(1),
  name: z.string().optional(),
  description: z.string().nullish(),
  created: z.number().nullish(),
  architecture: z
    .looseObject({
      input_modalities: z.array(z.string()).nullish(),
      output_modalities: z.array(z.string()).nullish(),
    })
    .nullish(),
  supported_parameters: imageSupportedParametersSchema,
  endpoints: z.string().nullish(),
});

const imagesResponseSchema = z.looseObject({ data: z.array(imagesEntrySchema) });

/** N+1 per-image-model endpoint detail carrying the pricing rows. */
const imageEndpointsResponseSchema = z.looseObject({
  data: z.looseObject({
    pricing: z
      .array(
        z.looseObject({
          billable: z.boolean().nullish(),
          unit: z.string(),
          cost_usd: z.string(),
        })
      )
      .nullish(),
  }),
});

// --- /videos/models --------------------------------------------------------

const videosEntrySchema = z.looseObject({
  id: z.string().min(1),
  name: z.string().optional(),
  description: z.string().nullish(),
  created: z.number().nullish(),
  supported_resolutions: z.array(z.string()).nullish(),
  supported_aspect_ratios: z.array(z.string()).nullish(),
  supported_durations: z.array(z.union([z.number(), z.string()])).nullish(),
  supported_frame_images: z.boolean().nullish(),
  generate_audio: z.boolean().nullish(),
  seed: z.boolean().nullish(),
  pricing_skus: z.record(z.string(), z.string()).nullish(),
});

const videosResponseSchema = z.looseObject({ data: z.array(videosEntrySchema) });

// --- typed catalog seam ----------------------------------------------------

/** Language token rates as decimal USD strings, exactly as OpenRouter reports. */
export interface LanguageTokenPricing {
  readonly prompt?: string | undefined;
  readonly completion?: string | undefined;
  readonly cacheRead?: string | undefined;
}

export interface ImagePricingEntry {
  readonly billable: boolean;
  readonly unit: string;
  readonly costUsd: string;
}

export interface ImageSupportedParameters {
  readonly resolution: readonly string[];
  readonly aspectRatio: readonly string[];
  readonly maxN: number | undefined;
}

export interface LanguageMetadata {
  /** Human-readable display name — carried through to the frontend catalog. */
  readonly name?: string | undefined;
  /** Human-readable model summary — feeds the Smart Model classifier prompt. */
  readonly description?: string | undefined;
  readonly source: 'language';
  readonly id: string;
  readonly provider: string;
  readonly inputModalities: readonly string[];
  readonly outputModalities: readonly string[];
  readonly supportedParameters: readonly string[];
  readonly contextLength: number | undefined;
  readonly pricing: LanguageTokenPricing | undefined;
  /** Release timestamp, UNIX SECONDS (the gateway's `created`). */
  readonly releasedAt: number | undefined;
  readonly deprecated: boolean;
}

export interface ImageMetadata {
  /** Human-readable display name — carried through to the frontend catalog. */
  readonly name?: string | undefined;
  /** Human-readable model summary — feeds the Smart Model classifier prompt. */
  readonly description?: string | undefined;
  readonly source: 'image';
  readonly id: string;
  readonly provider: string;
  readonly inputModalities: readonly string[];
  readonly supportedParameters: ImageSupportedParameters;
  readonly endpointPricing: readonly ImagePricingEntry[];
  /** Release timestamp, UNIX SECONDS (the gateway's `created`). */
  readonly releasedAt: number | undefined;
}

export interface VideoMetadata {
  /** Human-readable display name — carried through to the frontend catalog. */
  readonly name?: string | undefined;
  /** Human-readable model summary — feeds the Smart Model classifier prompt. */
  readonly description?: string | undefined;
  readonly source: 'video';
  readonly id: string;
  readonly provider: string;
  readonly supportsFrameImages: boolean;
  readonly generateAudio: boolean;
  readonly seed: boolean;
  readonly resolutions: readonly string[];
  readonly aspectRatios: readonly string[];
  readonly durations: readonly string[];
  readonly pricingSkus: Readonly<Record<string, string>>;
  /** Release timestamp, UNIX SECONDS (the gateway's `created`). */
  readonly releasedAt: number | undefined;
}

export type GatewayModelMetadata = LanguageMetadata | ImageMetadata | VideoMetadata;

export interface GatewayCatalog {
  readonly models: readonly GatewayModelMetadata[];
  /** Authoritative endpoint-granular ZDR membership, keyed by model id. */
  readonly zdrModelIds: ReadonlySet<string>;
}

export interface FetchGatewayCatalogOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
}

/** Cloudflare Workers allow six simultaneous outbound connections per
 * invocation; the image endpoints N+1 fan-out batches to that cap. */
const ENDPOINT_FETCH_CONCURRENCY = 6;

type FetchWhat =
  | 'models list'
  | 'ZDR list'
  | 'image models list'
  | 'image model endpoints'
  | 'video models list';

function fetchJson(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  what: FetchWhat
): ResultAsync<unknown, DomainError> {
  return fromPromise(fetchImpl(url), (cause) =>
    unavailableError(`${what} fetch failed`, cause)
  ).andThen((response) => {
    if (!response.ok) {
      return errAsync<unknown, DomainError>(
        unavailableError(`${what} returned HTTP ${String(response.status)}`)
      );
    }
    return fromPromise(response.json(), (cause) =>
      validationError(`${what} returned a non-JSON body`, cause)
    );
  });
}

/** Provider is the model id's first path segment (`openai/gpt` → `openai`). */
function providerOf(id: string): string {
  const slash = id.indexOf('/');
  return slash === -1 ? id : id.slice(0, slash);
}

function languageTokenPricingOf(
  pricing: z.infer<typeof modelsEntrySchema>['pricing']
): LanguageTokenPricing | undefined {
  if (pricing === undefined || pricing === null) return undefined;
  return {
    prompt: pricing.prompt,
    completion: pricing.completion,
    cacheRead: pricing.input_cache_read,
  };
}

function languageMetadata(entry: z.infer<typeof modelsEntrySchema>): LanguageMetadata {
  return {
    source: 'language',
    id: entry.id,
    provider: providerOf(entry.id),
    name: entry.name,
    description: entry.description ?? undefined,
    inputModalities: entry.architecture?.input_modalities ?? [],
    outputModalities: entry.architecture?.output_modalities ?? [],
    supportedParameters: entry.supported_parameters ?? [],
    contextLength: entry.context_length ?? undefined,
    pricing: languageTokenPricingOf(entry.pricing),
    releasedAt: entry.created ?? undefined,
    deprecated: typeof entry.expiration_date === 'string' && entry.expiration_date.length > 0,
  };
}

function imageSupportedParameters(
  raw: z.infer<typeof imageSupportedParametersSchema>
): ImageSupportedParameters {
  return {
    resolution: raw?.resolution ?? [],
    aspectRatio: raw?.aspect_ratio ?? [],
    maxN: raw?.n?.max ?? undefined,
  };
}

function imagePricingEntries(body: unknown): ImagePricingEntry[] {
  const parsed = imageEndpointsResponseSchema.parse(body);
  return (parsed.data.pricing ?? []).map((row) => ({
    billable: row.billable ?? true,
    unit: row.unit,
    costUsd: row.cost_usd,
  }));
}

function videoMetadata(entry: z.infer<typeof videosEntrySchema>): VideoMetadata {
  return {
    source: 'video',
    id: entry.id,
    provider: providerOf(entry.id),
    name: entry.name,
    description: entry.description ?? undefined,
    supportsFrameImages: entry.supported_frame_images ?? false,
    generateAudio: entry.generate_audio ?? false,
    seed: entry.seed ?? false,
    resolutions: entry.supported_resolutions ?? [],
    aspectRatios: entry.supported_aspect_ratios ?? [],
    durations: (entry.supported_durations ?? []).map(String),
    pricingSkus: entry.pricing_skus ?? {},
    releasedAt: entry.created ?? undefined,
  };
}

function fetchLanguageModels(
  options: FetchGatewayCatalogOptions
): ResultAsync<LanguageMetadata[], DomainError> {
  return fetchJson(options.fetch, `${options.baseUrl}/models`, 'models list').andThen((body) => {
    const parsed = modelsResponseSchema.safeParse(body);
    if (!parsed.success) {
      return errAsync<LanguageMetadata[], DomainError>(
        validationError('models list schema drift', parsed.error)
      );
    }
    return okAsync(parsed.data.data.map((entry) => languageMetadata(entry)));
  });
}

function fetchZdrModelIds(
  options: FetchGatewayCatalogOptions
): ResultAsync<ReadonlySet<string>, DomainError> {
  return fetchJson(options.fetch, `${options.baseUrl}/endpoints/zdr`, 'ZDR list').andThen(
    (body) => {
      const parsed = zdrResponseSchema.safeParse(body);
      if (!parsed.success) {
        return errAsync<ReadonlySet<string>, DomainError>(
          validationError('ZDR list schema drift', parsed.error)
        );
      }
      return okAsync(new Set(parsed.data.data.map((row) => row.model_id)));
    }
  );
}

function fetchImageModel(
  options: FetchGatewayCatalogOptions,
  entry: z.infer<typeof imagesEntrySchema>
): ResultAsync<ImageMetadata, DomainError> {
  const url = `${options.baseUrl}/images/models/${entry.id}/endpoints`;
  return fetchJson(options.fetch, url, 'image model endpoints').andThen((body) => {
    try {
      return okAsync<ImageMetadata, DomainError>({
        source: 'image',
        id: entry.id,
        provider: providerOf(entry.id),
        name: entry.name,
        description: entry.description ?? undefined,
        inputModalities: entry.architecture?.input_modalities ?? ['text'],
        supportedParameters: imageSupportedParameters(entry.supported_parameters),
        endpointPricing: imagePricingEntries(body),
        releasedAt: entry.created ?? undefined,
      });
    } catch (error) {
      return errAsync<ImageMetadata, DomainError>(
        validationError('image model endpoints schema drift', error)
      );
    }
  });
}

function fetchImageModels(
  options: FetchGatewayCatalogOptions
): ResultAsync<ImageMetadata[], DomainError> {
  return fetchJson(options.fetch, `${options.baseUrl}/images/models`, 'image models list').andThen(
    (body) => {
      const parsed = imagesResponseSchema.safeParse(body);
      if (!parsed.success) {
        return errAsync<ImageMetadata[], DomainError>(
          validationError('image models list schema drift', parsed.error)
        );
      }
      const entries = parsed.data.data;
      const chunks: (typeof entries)[number][][] = [];
      for (let index = 0; index < entries.length; index += ENDPOINT_FETCH_CONCURRENCY) {
        chunks.push(entries.slice(index, index + ENDPOINT_FETCH_CONCURRENCY));
      }
      let chain: ResultAsync<ImageMetadata[], DomainError> = okAsync([]);
      for (const chunk of chunks) {
        chain = chain.andThen((collected) =>
          ResultAsync.combine(chunk.map((entry) => fetchImageModel(options, entry))).map(
            (batch) => [...collected, ...batch]
          )
        );
      }
      return chain;
    }
  );
}

function fetchVideoModels(
  options: FetchGatewayCatalogOptions
): ResultAsync<VideoMetadata[], DomainError> {
  return fetchJson(options.fetch, `${options.baseUrl}/videos/models`, 'video models list').andThen(
    (body) => {
      const parsed = videosResponseSchema.safeParse(body);
      if (!parsed.success) {
        return errAsync<VideoMetadata[], DomainError>(
          validationError('video models list schema drift', parsed.error)
        );
      }
      return okAsync(parsed.data.data.map((entry) => videoMetadata(entry)));
    }
  );
}

export function fetchGatewayCatalog(
  options: FetchGatewayCatalogOptions
): ResultAsync<GatewayCatalog, DomainError> {
  return ResultAsync.combine([
    fetchLanguageModels(options),
    fetchImageModels(options),
    fetchVideoModels(options),
    fetchZdrModelIds(options),
  ]).map(([language, image, video, zdrModelIds]) => ({
    models: [...language, ...image, ...video],
    zdrModelIds,
  }));
}
