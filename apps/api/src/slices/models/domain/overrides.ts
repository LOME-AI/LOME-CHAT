import { z } from 'zod';
import { NanoUSD, ParamSpec as ParameterSpec } from '@hushbox/shared';

/**
 * Contract for the `model_overrides.overrides` jsonb — the manual supplement
 * for capability gaps gateway metadata cannot express (ParamSpecs for
 * image/video, pricing matrices, model-level ZDR exclusion). The models
 * slice owns the table, so it owns this payload contract. Strict: an
 * unknown key in admin-supplied data is a defect, not a forward-compat
 * affordance.
 */

/** Pricing in wire form: nano-USD strings, one nested level for matrices. */
const nanoUsdString = z.string().refine((value) => NanoUSD.safeParse(value).success, {
  message: 'Pricing values must be canonical nano-USD decimal strings',
});

const pricingWire = z.record(
  z.string(),
  z.union([nanoUsdString, z.record(z.string(), nanoUsdString)])
);

export const ModelOverrideData = z.strictObject({
  parameters: z.record(z.string(), ParameterSpec).optional(),
  pricing: pricingWire.optional(),
  /** Documented model-level exclusion: provider is on the gateway ZDR list
   * but this specific model is not covered — forces zdrReachable false. */
  zdrExcluded: z.boolean().optional(),
});

export type ModelOverrideData = z.infer<typeof ModelOverrideData>;

/** A parsed model_overrides row as domain code consumes it. */
export interface ModelOverride {
  readonly modelId: string;
  readonly data: ModelOverrideData;
  readonly zdrVerifiedAt: Date | null;
}

export const ZDR_VERIFICATION_MAX_AGE_DAYS = 90;

const DAY_MS = 86_400_000;

/** ZDR verifications are dated, aged data: past 90 days they alert (the
 * model stays exposed — aging is an alert condition, not a hide). */
export function isZdrVerificationAged(verifiedAt: Date, now: Date): boolean {
  return now.getTime() - verifiedAt.getTime() > ZDR_VERIFICATION_MAX_AGE_DAYS * DAY_MS;
}
