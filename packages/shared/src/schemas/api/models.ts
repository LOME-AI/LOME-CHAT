import { z } from 'zod';
import { ModelReasoning } from '../../model-descriptor.js';

// No code currently produces 'internet-search'; search runs via a Perplexity tool
// universally, not as a per-model capability. The enum is kept as a placeholder
// so adding future image/video capabilities doesn't require widening an empty enum.
export const modelCapabilitySchema = z.enum(['internet-search']);

export type ModelCapability = z.infer<typeof modelCapabilitySchema>;

export const modelModalitySchema = z.enum(['text', 'image', 'audio', 'video']);

export type ModelModality = z.infer<typeof modelModalitySchema>;

/**
 * Per-model pricing on the wire: BASE (pre-markup) integer nano-USD rates,
 * each carried as a canonical decimal STRING. Money never crosses JSON as a
 * float (2^53 truncation) or a bigint (not JSON-serializable) — the string is
 * the boundary form, parsed to a branded `NanoUSD` bigint by consumers.
 *
 * Keys mirror the server `Pricing` descriptor
 * (`inputPerToken`/`outputPerToken`/`perImage`/`perSecondByResolution`); each
 * is optional because a model carries only the rates for its own modality.
 * The 15% markup is applied exactly once, downstream, by the canonical cost
 * estimator — the wire rate is the raw provider cost, never fee-inclusive.
 */
export const wireModelPricingSchema = z.object({
  inputPerToken: z.string().optional(),
  outputPerToken: z.string().optional(),
  perImage: z.string().optional(),
  perSecondByResolution: z.record(z.string(), z.string()).optional(),
});

export type WireModelPricing = z.infer<typeof wireModelPricingSchema>;

/**
 * Pricing-shape view of a Model used by the modality refines. Pulled out so
 * each per-modality validator can stay tiny and focused.
 *
 * Discriminated-union refactor was considered but deferred — too invasive
 * across 30+ consumers. Refine enforces the same invariants.
 */
interface PricingShape {
  modality: 'text' | 'image' | 'audio' | 'video';
  pricing: WireModelPricing;
}

/** A nano-USD wire rate is positive iff present and neither zero nor negative. */
function isPositiveNano(rate: string | undefined): boolean {
  return rate !== undefined && rate !== '0' && !rate.startsWith('-');
}

function hasResolutionEntries(pricing: WireModelPricing): boolean {
  return (
    pricing.perSecondByResolution !== undefined &&
    Object.keys(pricing.perSecondByResolution).length > 0
  );
}

function hasTokenPricing(pricing: WireModelPricing): boolean {
  return isPositiveNano(pricing.inputPerToken) || isPositiveNano(pricing.outputPerToken);
}

type PricingRate = 'inputPerToken' | 'outputPerToken' | 'perImage' | 'perSecondByResolution';

function addPricingIssue(ctx: z.RefinementCtx, message: string, rate: PricingRate): void {
  ctx.addIssue({ code: 'custom', message, path: ['pricing', rate] });
}

function refineTextPricing({ pricing }: PricingShape, ctx: z.RefinementCtx): void {
  if (isPositiveNano(pricing.perImage)) {
    addPricingIssue(ctx, 'Text models must not set perImage pricing', 'perImage');
  }
  if (hasResolutionEntries(pricing)) {
    addPricingIssue(
      ctx,
      'Text models must not set perSecondByResolution entries',
      'perSecondByResolution'
    );
  }
}

function refineImagePricing({ pricing }: PricingShape, ctx: z.RefinementCtx): void {
  if (hasTokenPricing(pricing)) {
    addPricingIssue(ctx, 'Image models must not set token pricing', 'inputPerToken');
  }
  if (hasResolutionEntries(pricing)) {
    addPricingIssue(
      ctx,
      'Image models must not set perSecondByResolution entries',
      'perSecondByResolution'
    );
  }
  if (!isPositiveNano(pricing.perImage)) {
    addPricingIssue(ctx, 'Image models must declare a positive perImage rate', 'perImage');
  }
}

function refineVideoPricing({ pricing }: PricingShape, ctx: z.RefinementCtx): void {
  if (hasTokenPricing(pricing)) {
    addPricingIssue(ctx, 'Video models must not set token pricing', 'inputPerToken');
  }
  if (isPositiveNano(pricing.perImage)) {
    addPricingIssue(ctx, 'Video models must not set perImage pricing', 'perImage');
  }
  if (!hasResolutionEntries(pricing)) {
    addPricingIssue(
      ctx,
      'Video models must declare at least one perSecondByResolution entry',
      'perSecondByResolution'
    );
  }
}

function refineAudioPricing({ pricing }: PricingShape, ctx: z.RefinementCtx): void {
  // Audio carries no wire pricing dimension (the descriptor exposes no audio
  // rate key today — audio inference is deferred). The guard only rejects
  // foreign-modality rates leaking onto an audio row.
  if (hasTokenPricing(pricing)) {
    addPricingIssue(ctx, 'Audio models must not set token pricing', 'inputPerToken');
  }
  if (isPositiveNano(pricing.perImage)) {
    addPricingIssue(ctx, 'Audio models must not set perImage pricing', 'perImage');
  }
  if (hasResolutionEntries(pricing)) {
    addPricingIssue(
      ctx,
      'Audio models must not set perSecondByResolution entries',
      'perSecondByResolution'
    );
  }
}

const MODALITY_REFINERS: Record<
  PricingShape['modality'],
  (model: PricingShape, ctx: z.RefinementCtx) => void
> = {
  text: refineTextPricing,
  image: refineImagePricing,
  video: refineVideoPricing,
  audio: refineAudioPricing,
};

/**
 * Validate that a model's pricing rates match its declared modality. Each
 * modality owns one pricing dimension; mismatches are bugs (e.g., a text
 * model accidentally getting per-image pricing from the gateway). Catching
 * them at the schema boundary prevents bad data from leaking into the UI or
 * billing pipeline — and lets the wire projection safely drop any row whose
 * pricing shape is inconsistent (`list-models` relies on this).
 */
function refineModalityPricing(model: PricingShape, ctx: z.RefinementCtx): void {
  MODALITY_REFINERS[model.modality](model, ctx);
}

/**
 * Schema for an AI model available through the AI Gateway.
 *
 * Pricing contract: `pricing` carries BASE (pre-markup) integer nano-USD rates
 * as canonical decimal strings — the raw provider cost, projected directly
 * from the server `Pricing` descriptor in `list-models`. The 15% markup is
 * applied exactly once downstream by the canonical cost estimator; consumers
 * must NOT re-apply fees here.
 */
export const modelSchema = z
  .object({
    /** Unique model identifier (e.g., "openai/gpt-4-turbo") */
    id: z.string().min(1),

    /** Human-readable model name (e.g., "GPT-4 Turbo") */
    name: z.string().min(1),

    /** Provider name (e.g., "OpenAI", "Anthropic") */
    provider: z.string().min(1),

    /** Output modality of the model (text or image). Defaults to text for back-compat. */
    modality: modelModalitySchema.default('text'),

    /** Maximum context window in tokens (text models); for image models this is 0 or irrelevant. */
    contextLength: z.number().int().nonnegative(),

    /**
     * The provider's completion ceiling (`descriptor.limits.maxOutputTokens`,
     * ingested from the gateway catalog). Bounds every client-side output
     * ceiling via the shared estimator functions — strict tightening; absent
     * means the context length alone bounds (uncapped models, media rows,
     * and the synthetic Smart Model row, whose per-candidate caps carry it).
     */
    maxOutputTokens: z.number().int().positive().optional(),

    /** BASE (pre-markup) per-model pricing rates in nano-USD strings. */
    pricing: wireModelPricingSchema.default({}),

    /** Model capabilities */
    capabilities: z.array(modelCapabilitySchema),

    /** Human-readable description of the model */
    description: z.string().min(1),

    /**
     * AI Gateway API parameters supported by this model.
     * Used to determine which capabilities can be enabled.
     * Example: ['tools', 'temperature', 'top_p', 'max_tokens']
     */
    supportedParameters: z.array(z.string()).default([]),

    /** Unix timestamp when the model was created */
    created: z.number().optional(),

    /** Whether this model is the synthetic Smart Model router */
    isSmartModel: z.boolean().optional(),

    /**
     * Cheapest-pool BASE nano pricing across the Smart Model's pool (lower
     * bound of the price-range display). Present only on the Smart Model row.
     */
    minPricing: wireModelPricingSchema.optional(),

    /**
     * Most-expensive-pool BASE nano pricing across the Smart Model's pool
     * (upper bound of the price-range display). Present only on the Smart
     * Model row.
     */
    maxPricing: wireModelPricingSchema.optional(),

    /**
     * Aspect ratios this model accepts (e.g., `['1:1', '16:9']` for images,
     * `['16:9', '9:16']` for Veo videos). Populated per-modality from
     * provider-side capability data — the public gateway catalog doesn't
     * expose this consistently, so values are pinned in `list-models`
     * against each ZDR-allowlisted provider's docs.
     */
    supportedAspectRatios: z.array(z.string()).optional(),

    /**
     * Video resolutions this model accepts (e.g., `['720p', '1080p']` for
     * Veo 3.0, `['720p', '1080p', '4k']` for Veo 3.1). Distinct from
     * `pricing.perSecondByResolution` keys because some entries are
     * billing-only (a price exists but the SDK rejects the value) or vice
     * versa. Set explicitly so the UI can compute multi-model agreement.
     */
    supportedVideoResolutions: z.array(z.string()).optional(),

    /**
     * Discrete supported video durations in seconds (e.g., `[4, 6, 8]` for
     * every current Veo 3.x model). Sets may be non-uniform — the UI's
     * snap-to-nearest slider reads this list directly.
     */
    supportedVideoDurationsSeconds: z.array(z.number().int().positive()).optional(),

    /**
     * OpenRouter top-weekly usage rank, 0-based (lower = more used); drives the
     * model-selector default sort; absent for media/unranked models.
     */
    popularityRank: z.number().int().nonnegative().optional(),

    /**
     * OpenRouter's per-model reasoning metadata, verbatim from the descriptor
     * (`supportedEfforts` raw upstream strings — consumers intersect with the
     * canonical effort enum at use). Absent for the 131/342 models without a
     * reasoning object and for pre-existing wire rows.
     */
    reasoning: ModelReasoning.optional(),
  })
  .refine((model) => (model.modality === 'text' ? model.contextLength > 0 : true), {
    message: 'Text models must have a positive contextLength',
    path: ['contextLength'],
  })
  .superRefine(refineModalityPricing);

export type Model = z.infer<typeof modelSchema>;

/**
 * Response from GET /models endpoint. Single source of truth for the wire
 * contract — the inferred type flows to consumers, no manual mirror.
 */
export const modelsListResponseSchema = z.object({
  models: z.array(modelSchema),
  premiumModelIds: z.array(z.string()),
});

export type ModelsListResponse = z.infer<typeof modelsListResponseSchema>;
