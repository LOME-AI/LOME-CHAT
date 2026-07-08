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
  // Release timestamp as UNIX SECONDS (OpenRouter's `created`). Required and
  // always present: a model whose source metadata carries no release date is
  // excluded at normalization (fail-closed), never exposed with the field
  // absent. Drives the trial premium-recency gate (multiply by 1000 for ms).
  releasedAt: z.number(),
  fetchedAt: z.number(),
});

export type ModelDescriptor = z.infer<typeof ModelDescriptor>;
