import { z } from 'zod';
import type { Modality, RawModel } from './types.js';

interface CacheEntry {
  publicModelsUrl: string;
  data: RawModel[];
  expiresAt: number;
}

const MODEL_CACHE_TTL_MS = 3_600_000;

// 10s matches the watchdog's FETCH_TIMEOUT_MS in live-catalog-drift.test.ts;
// production runs inside a Cloudflare Worker whose own request budget makes a
// longer wait pointless — better to fail fast and surface the upstream stall.
const FETCH_TIMEOUT_MS = 10_000;

let modelsCache: CacheEntry | null = null;

/** Test-only: clears the in-memory model cache. */
export function clearModelCache(): void {
  modelsCache = null;
}

const DEFAULT_CONTEXT_LENGTH = 128_000;

const videoDurationPricingEntrySchema = z.object({
  resolution: z.string(),
  audio: z.boolean(),
  cost_per_second: z.string(),
});

/**
 * Per-entry schema is permissive on unknown fields (passthrough) but strict
 * on the fields we actually consume. Unknown-shape entries get filtered
 * downstream in `processModels` via the `has flat pricing` check — no need
 * to fail the whole batch over a single unknown pricing variant.
 */
export const publicModelEntrySchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  created: z.number().optional(),
  released: z.number().optional(),
  context_window: z.number().optional(),
  type: z.string().optional(),
  pricing: z.record(z.string(), z.unknown()).optional(),
});

export type PublicModelEntry = z.infer<typeof publicModelEntrySchema>;

const publicModelsResponseSchema = z.object({
  data: z.array(publicModelEntrySchema),
});

/**
 * Classifies a model's modality from the public `type` field.
 * Anything outside the explicit `image | video | audio` set collapses to
 * `text` (embeddings aren't user-selectable in our UI and won't pass ZDR
 * filters anyway).
 */
function classifyModality(type: string | null | undefined): Modality {
  switch (type) {
    case 'image': {
      return 'image';
    }
    case 'video': {
      return 'video';
    }
    case 'audio': {
      return 'audio';
    }
    default: {
      return 'text';
    }
  }
}

function extractStringPricing(
  pricing: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  if (!pricing) return undefined;
  const value = pricing[key];
  if (typeof value === 'string') return value;
  return undefined;
}

/**
 * Returns the effective per-token rate for `key` (`'input'` or `'output'`):
 * the top-level standard rate.
 *
 * The gateway's `service_tiers.flex` band is deliberately ignored. We no longer
 * send `serviceTier: 'flex'` on inference calls (see ZDR_PROVIDER_OPTIONS — the
 * gateway hard-rejects flex for models that don't expose it), so every request
 * routes and bills at standard. Estimating against the flex band (~50% of
 * standard) while billing at standard would systematically under-reserve, so
 * the estimate must track the standard rate the gateway actually charges.
 */
function extractEffectivePerTokenPricing(
  pricing: Record<string, unknown> | undefined,
  key: 'input' | 'output'
): string | undefined {
  return extractStringPricing(pricing, key);
}

/**
 * Extract flat per-image price from a public-endpoint entry.
 * Returns undefined for empty pricing or variable (`image_dimension_quality_pricing`)
 * entries, which are filtered out downstream in processModels.
 */
function extractImagePricing(pricing: Record<string, unknown> | undefined): string | undefined {
  if (!pricing) return undefined;
  const flat = pricing['image'];
  if (typeof flat === 'string') return flat;
  return undefined;
}

/**
 * Extract per-resolution per-second prices from a public-endpoint entry.
 * Prefers the `audio: true` entry per resolution (HushBox always requests
 * audio when the model supports it). Falls back to `audio: false`
 * when only that variant is priced. Returns undefined for video models that
 * use `video_token_pricing` (per-token billing, out of scope for v1) or when
 * `video_duration_pricing` entries fail validation.
 */
function extractVideoPricing(
  pricing: Record<string, unknown> | undefined
): Record<string, string> | undefined {
  if (!pricing) return undefined;
  const raw = pricing['video_duration_pricing'];
  if (!Array.isArray(raw)) return undefined;
  const parsed = z.array(videoDurationPricingEntrySchema).safeParse(raw);
  if (!parsed.success) return undefined;
  const byResolution: Record<string, string> = {};
  for (const entry of parsed.data) {
    const existing = byResolution[entry.resolution];
    if (existing === undefined || entry.audio) {
      byResolution[entry.resolution] = entry.cost_per_second;
    }
  }
  return byResolution;
}

function buildPricing(modality: Modality, entry: PublicModelEntry): RawModel['pricing'] {
  const base = {
    prompt: extractEffectivePerTokenPricing(entry.pricing, 'input') ?? '0',
    completion: extractEffectivePerTokenPricing(entry.pricing, 'output') ?? '0',
  };
  if (modality === 'image') {
    const perImage = extractImagePricing(entry.pricing);
    return perImage === undefined ? base : { ...base, per_image: perImage };
  }
  if (modality === 'video') {
    const perSecondByResolution = extractVideoPricing(entry.pricing);
    return perSecondByResolution === undefined
      ? base
      : { ...base, per_second_by_resolution: perSecondByResolution };
  }
  return base;
}

function buildArchitecture(modality: Modality): RawModel['architecture'] {
  const modalities = modality === 'text' ? ['text'] : [modality];
  return { input_modalities: modalities, output_modalities: modalities };
}

export function toRawModel(entry: PublicModelEntry): RawModel {
  const modality = classifyModality(entry.type);
  return {
    id: entry.id,
    name: entry.name ?? entry.id,
    description: entry.description ?? '',
    modality,
    context_length: entry.context_window ?? DEFAULT_CONTEXT_LENGTH,
    pricing: buildPricing(modality, entry),
    supported_parameters: [],
    // `released` is the actual model release date; `created` is the gateway's
    // catalog-import stamp (flat across the batch) and would mark every entry
    // as recent. Prefer `released` so the premium-by-recency check evaluates
    // the model's real age.
    created: entry.released ?? entry.created ?? 0,
    architecture: buildArchitecture(modality),
  };
}

export interface FetchModelsOptions {
  /**
   * URL of the unauthenticated `/v1/models` endpoint. Production points at
   * `https://ai-gateway.vercel.sh/v1/models`; tests stub `globalThis.fetch`.
   */
  publicModelsUrl: string;
  /**
   * Optional fetch implementation. Defaults to `globalThis.fetch`. The HTTP
   * cassette layer in `apps/api/src/services/ai/cassette/` passes a wrapped
   * fetch here so integration tests record/replay the catalog read alongside
   * the gateway calls; production callers omit this and use the default.
   */
  fetch?: typeof globalThis.fetch;
}

/**
 * Fetch available models from the AI Gateway's unauthenticated `/v1/models`
 * endpoint. The catalog is a public list — no API key required.
 *
 * Results are cached in memory for 1 hour per URL. On HTTP error, network
 * failure, or schema drift, throws a clear error rather than returning empty.
 */
export async function fetchModels(options: FetchModelsOptions): Promise<RawModel[]> {
  const { publicModelsUrl, fetch: customFetch } = options;
  if (modelsCache?.publicModelsUrl === publicModelsUrl && Date.now() < modelsCache.expiresAt) {
    // structuredClone isolates the cached array from caller mutation
    // (push/sort/splice would otherwise corrupt the cache for the remaining TTL).
    return structuredClone(modelsCache.data);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, FETCH_TIMEOUT_MS);

  const fetchImpl = customFetch ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(publicModelsUrl, { signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(
        `Public models endpoint fetch timed out after ${String(FETCH_TIMEOUT_MS)}ms (${publicModelsUrl})`
      );
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    throw new Error(
      `Public models endpoint returned HTTP ${String(response.status)} ${response.statusText}`
    );
  }
  const body = (await response.json()) as unknown;
  const parsed = publicModelsResponseSchema.parse(body);
  const data = parsed.data.map((entry) => toRawModel(entry));

  modelsCache = {
    publicModelsUrl,
    data,
    expiresAt: Date.now() + MODEL_CACHE_TTL_MS,
  };

  return structuredClone(data);
}
