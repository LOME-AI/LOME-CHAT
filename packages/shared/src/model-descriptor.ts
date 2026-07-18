import { z } from 'zod';
import { Modality } from './modality.js';
import { NanoUSD } from './nano-usd.js';
import { ParamSpec as ParameterSpec } from './param-spec.js';

/**
 * Pricing rates in integer nano-USD — estimates and display ONLY, never
 * billing (the gateway's per-generation cost is billing truth). Flat
 * named rates, with one nested level for per-size/per-resolution matrices
 * (image/video models). Rates cross JSON as NanoUSD strings.
 */
export const PricingSchema = z.record(
  z.string(),
  z.union([NanoUSD, z.record(z.string(), NanoUSD)])
);

export type Pricing = z.infer<typeof PricingSchema>;

/**
 * The closed set of SDK call-shape families. Dispatch keys on call shape,
 * not on model identity: a genuinely new modality is one enum migration plus
 * one dispatch adapter (ARCHITECTURE.md "Models & capabilities").
 */
export const CALL_SHAPE_FAMILIES = ['language', 'image', 'video', 'embedding'] as const;

export type CallShapeFamily = (typeof CALL_SHAPE_FAMILIES)[number];

/**
 * Descriptor outputs → call-shape family, total over every output
 * combination. Exposure gating (the dated-ZDR media gate) and adapter
 * routing MUST classify a descriptor identically — if they diverge, a
 * media-routed model can skip the media exposure gate — which is why this
 * single derivation is the only source both consume.
 *
 * Precedence: any text output streams through the language call-shape
 * (text+media models emit file parts); embedding beats bare media; image
 * beats video, so ['image','video'] is media-classified, never language;
 * no match returns `undefined` so callers exclude-with-alert, never guess.
 */
export function callShapeFamilyFor(outputs: readonly Modality[]): CallShapeFamily | undefined {
  if (outputs.includes('text')) return 'language';
  if (outputs.includes('embedding')) return 'embedding';
  if (outputs.includes('image')) return 'image';
  if (outputs.includes('video')) return 'video';
  return undefined;
}

/**
 * A model runs a turn iff it accepts text input (we send text today;
 * additional declared input modalities are allowed but currently unused)
 * AND produces exactly one routable output modality (text | image | video;
 * not audio, not embedding, not multi-output). This is the single shared
 * predicate both catalog admission (models slice) and the engine's port
 * derivation gate on — one definition so the two never diverge.
 */
export function isRunnableModelShape(shape: Pick<ModelDescriptor, 'inputs' | 'outputs'>): boolean {
  const family = callShapeFamilyFor(shape.outputs);
  return (
    shape.inputs.includes('text') &&
    shape.outputs.length === 1 &&
    family !== undefined &&
    family !== 'embedding'
  );
}

/**
 * A model self-describes. Descriptors are data; modalities are the
 * closed enum. `zdrReachable` reflects membership in OpenRouter's
 * authoritative `/endpoints/zdr` list — models absent from it are treated
 * as unreachable and hidden (fail-closed).
 */
export const ModelDescriptor = z.object({
  id: z.string().min(1),
  provider: z.string().min(1),
  version: z.string().min(1),
  inputs: z.array(Modality),
  outputs: z.array(Modality),
  parameters: z.record(z.string(), ParameterSpec),
  behaviors: z.array(z.string()), // 'streaming' | 'tools' | 'reasoning' | 'web-search' | …
  limits: z.record(z.string(), z.number()),
  pricing: PricingSchema,
  zdrReachable: z.boolean(),
  // Human-readable display name from the source metadata, carried for the
  // frontend catalog (raw slugs alone are not user-facing). Optional and
  // defaulted-absent by design: additive to the persisted jsonb, so descriptor
  // rows written before this field parse unchanged — absence never excludes.
  name: z.string().optional(),
  // Human-readable model summary from the source metadata, carried for the
  // Smart Model classifier prompt. Optional by design: a model without one
  // renders id-only in the prompt — absence never excludes a model.
  description: z.string().optional(),
  // Release timestamp as UNIX SECONDS (OpenRouter's `created`). Required and
  // always present: a model whose source metadata carries no release date is
  // excluded at normalization (fail-closed), never exposed with the field
  // absent. Drives the trial premium-recency gate (multiply by 1000 for ms).
  releasedAt: z.number(),
  fetchedAt: z.number(),
  // OpenRouter top-weekly usage rank, 0-based (lower = more used); populated
  // from a DB column at read time, never persisted in the descriptor JSONB;
  // optional because media/unranked models have none.
  popularityRank: z.number().int().nonnegative().optional(),
});

export type ModelDescriptor = z.infer<typeof ModelDescriptor>;
