import { z } from 'zod';

// No code currently produces 'internet-search'; search runs via a Perplexity tool
// universally, not as a per-model capability. The enum is kept as a placeholder
// so adding future image/video capabilities doesn't require widening an empty enum.
export const modelCapabilitySchema = z.enum(['internet-search']);

export type ModelCapability = z.infer<typeof modelCapabilitySchema>;

export const modelModalitySchema = z.enum(['text', 'image', 'audio', 'video']);

export type ModelModality = z.infer<typeof modelModalitySchema>;

/**
 * Pricing-shape view of a Model used by the modality refines. Pulled out so
 * each per-modality validator can stay tiny and focused.
 *
 * Discriminated-union refactor was considered but deferred — too invasive
 * across 30+ consumers. Refine enforces the same invariants.
 */
interface PricingShape {
  modality: 'text' | 'image' | 'audio' | 'video';
  pricePerInputToken: number;
  pricePerOutputToken: number;
  pricePerImage: number;
  pricePerSecondByResolution: Record<string, number>;
  pricePerSecond: number;
}

function hasResolutionEntries(model: PricingShape): boolean {
  return Object.keys(model.pricePerSecondByResolution).length > 0;
}

function hasTokenPricing(model: PricingShape): boolean {
  return model.pricePerInputToken > 0 || model.pricePerOutputToken > 0;
}

function addPricingIssue(ctx: z.RefinementCtx, message: string, path: keyof PricingShape): void {
  ctx.addIssue({ code: 'custom', message, path: [path] });
}

function refineTextPricing(model: PricingShape, ctx: z.RefinementCtx): void {
  if (model.pricePerImage > 0) {
    addPricingIssue(ctx, 'Text models must not set pricePerImage', 'pricePerImage');
  }
  if (model.pricePerSecond > 0) {
    addPricingIssue(ctx, 'Text models must not set pricePerSecond', 'pricePerSecond');
  }
  if (hasResolutionEntries(model)) {
    addPricingIssue(
      ctx,
      'Text models must not set pricePerSecondByResolution entries',
      'pricePerSecondByResolution'
    );
  }
}

function refineImagePricing(model: PricingShape, ctx: z.RefinementCtx): void {
  if (hasTokenPricing(model)) {
    addPricingIssue(
      ctx,
      'Image models must not set pricePerInputToken or pricePerOutputToken',
      'pricePerInputToken'
    );
  }
  if (model.pricePerSecond > 0) {
    addPricingIssue(ctx, 'Image models must not set pricePerSecond', 'pricePerSecond');
  }
  if (hasResolutionEntries(model)) {
    addPricingIssue(
      ctx,
      'Image models must not set pricePerSecondByResolution entries',
      'pricePerSecondByResolution'
    );
  }
  if (model.pricePerImage <= 0) {
    addPricingIssue(ctx, 'Image models must declare pricePerImage > 0', 'pricePerImage');
  }
}

function refineVideoPricing(model: PricingShape, ctx: z.RefinementCtx): void {
  if (hasTokenPricing(model)) {
    addPricingIssue(
      ctx,
      'Video models must not set pricePerInputToken or pricePerOutputToken',
      'pricePerInputToken'
    );
  }
  if (model.pricePerImage > 0) {
    addPricingIssue(ctx, 'Video models must not set pricePerImage', 'pricePerImage');
  }
  if (model.pricePerSecond > 0) {
    addPricingIssue(
      ctx,
      'Video models must not set pricePerSecond (use pricePerSecondByResolution)',
      'pricePerSecond'
    );
  }
  if (!hasResolutionEntries(model)) {
    addPricingIssue(
      ctx,
      'Video models must declare at least one pricePerSecondByResolution entry',
      'pricePerSecondByResolution'
    );
  }
}

function refineAudioPricing(model: PricingShape, ctx: z.RefinementCtx): void {
  if (hasTokenPricing(model)) {
    addPricingIssue(
      ctx,
      'Audio models must not set pricePerInputToken or pricePerOutputToken',
      'pricePerInputToken'
    );
  }
  if (model.pricePerImage > 0) {
    addPricingIssue(ctx, 'Audio models must not set pricePerImage', 'pricePerImage');
  }
  if (hasResolutionEntries(model)) {
    addPricingIssue(
      ctx,
      'Audio models must not set pricePerSecondByResolution (audio is flat per-second)',
      'pricePerSecondByResolution'
    );
  }
  if (model.pricePerSecond <= 0) {
    addPricingIssue(ctx, 'Audio models must declare pricePerSecond > 0', 'pricePerSecond');
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
 * Validate that a model's pricing fields match its declared modality. Each
 * modality owns one pricing dimension; mismatches are bugs (e.g., a text
 * model accidentally getting per-image pricing from the gateway). Catching
 * them at the schema boundary prevents bad data from leaking into the UI or
 * billing pipeline.
 */
function refineModalityPricing(model: PricingShape, ctx: z.RefinementCtx): void {
  MODALITY_REFINERS[model.modality](model, ctx);
}

/**
 * Schema for an AI model available through the AI Gateway.
 *
 * Fee contract: every `pricePer*` / `minPricePer*` / `maxPricePer*` price
 * field on a `Model` is FEE-INCLUSIVE (raw provider price multiplied by
 * `1 + TOTAL_FEE_RATE`). Fees are applied once by `processModels` (see
 * `packages/shared/src/models/process-models.ts`); downstream consumers
 * (UI display, sort, budget math, billing) must NOT re-apply fees.
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

    /** Fee-inclusive cost per input token in USD (text models); 0 for non-text. */
    pricePerInputToken: z.number().nonnegative(),

    /** Fee-inclusive cost per output token in USD (text models); 0 for non-text. */
    pricePerOutputToken: z.number().nonnegative(),

    /** Fee-inclusive cost per image in USD (image models); 0 for non-image. */
    pricePerImage: z.number().nonnegative().default(0),

    /**
     * Fee-inclusive cost per second of output in USD, keyed by resolution
     * (video models). Empty for non-video models. Populated from the
     * gateway's `video_duration_pricing` array, preferring the `audio: true`
     * entry per resolution since HushBox always requests audio when supported.
     */
    pricePerSecondByResolution: z.record(z.string(), z.number().nonnegative()).default({}),

    /**
     * Flat fee-inclusive per-second cost in USD for audio (TTS) models. 0 for
     * non-audio models. Audio is priced per-second of generated speech (no
     * resolution split, unlike video).
     */
    pricePerSecond: z.number().nonnegative().default(0),

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

    /** Fee-inclusive minimum input price per token across the Smart Model's pool (for price range display) */
    minPricePerInputToken: z.number().nonnegative().optional(),

    /** Fee-inclusive minimum output price per token across the Smart Model's pool (for price range display) */
    minPricePerOutputToken: z.number().nonnegative().optional(),

    /** Fee-inclusive maximum input price per token across the Smart Model's pool (for price range display) */
    maxPricePerInputToken: z.number().nonnegative().optional(),

    /** Fee-inclusive maximum output price per token across the Smart Model's pool (for price range display) */
    maxPricePerOutputToken: z.number().nonnegative().optional(),

    /**
     * Aspect ratios this model accepts (e.g., `['1:1', '16:9']` for images,
     * `['16:9', '9:16']` for Veo videos). Populated per-modality from
     * provider-side capability data — the public gateway catalog doesn't
     * expose this consistently, so values are pinned in `process-models.ts`
     * against each ZDR-allowlisted provider's docs.
     */
    supportedAspectRatios: z.array(z.string()).optional(),

    /**
     * Video resolutions this model accepts (e.g., `['720p', '1080p']` for
     * Veo 3.0, `['720p', '1080p', '4k']` for Veo 3.1). Distinct from
     * `pricePerSecondByResolution` keys because some entries are
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
