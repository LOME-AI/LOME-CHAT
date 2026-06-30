/**
 * Billing-result types shared between the streaming pipeline and modality
 * strategies.
 *
 * `stream-pipeline.ts` exports the resolver functions that produce these shapes
 * (`resolveAndReserveImageBilling`, etc.). `modality-strategies.ts` consumes
 * them to type the per-modality `pricingFor` / `buildRequest` callbacks. Owning
 * the type declarations here breaks the import cycle between those two
 * modules — both import from this leaf file instead of each other.
 *
 * Also owns `MediaPersistPricing`, the per-kind pricing+metadata shape passed
 * from the strategy callbacks into the shared media persistence helper.
 */

import type { VideoResolution } from '@hushbox/shared/models';

import type { MemberContext } from '../services/billing/index.js';
import type { GroupBudgetReservation } from './speculative-balance.js';

/**
 * Persist-time group billing context: present only when a group reservation
 * was made (member is not the owner AND a group budget was reserved). Three
 * pipelines need exactly this conditional spread; centralising it keeps the
 * "group reservation produces the persistence row" rule in one place instead
 * of an open-coded ternary at each call site.
 */
export function buildGroupBillingContext(
  memberContext: MemberContext | undefined,
  groupBudget: GroupBudgetReservation | undefined
): { memberId: string } | undefined {
  if (memberContext === undefined || groupBudget === undefined) return undefined;
  return { memberId: memberContext.memberId };
}

export interface ImageBillingValidationSuccess {
  success: true;
  worstCaseCents: number;
  groupBudget?: GroupBudgetReservation;
  billingUserId: string;
  /**
   * Per-image price for each selected model, keyed by model ID. The pipeline
   * uses this map to bill each model at its own price (not the max) after
   * generation completes.
   */
  perImageByModel: Map<string, number>;
}

export interface VideoBillingValidationSuccess {
  success: true;
  worstCaseCents: number;
  groupBudget?: GroupBudgetReservation;
  billingUserId: string;
  /**
   * Per-second price at the chosen resolution for each selected video model,
   * keyed by model ID. The pipeline uses this map for per-model billing.
   */
  perSecondByModel: Map<string, number>;
  durationSeconds: number;
  resolution: VideoResolution;
}

export interface AudioBillingValidationSuccess {
  success: true;
  worstCaseCents: number;
  groupBudget?: GroupBudgetReservation;
  billingUserId: string;
  /** Per-second price for each selected audio model, keyed by model ID. */
  perSecondByModel: Map<string, number>;
  /** Upper bound the user picked for worst-case reservation. */
  maxDurationSeconds: number;
}

/**
 * Per-kind pricing and output metadata for the shared media persistence helper.
 * Discriminates the fields that vary by media kind (per-image vs per-second,
 * dimensions vs duration) so one code path handles all media modalities.
 *
 * Note for audio: `durationSeconds` is derived from the actual generated
 * `durationMs`, not from the request — TTS duration is determined by the
 * synthesis. The pricing factory in the audio pipeline reads `result.durationMs`
 * via the `pricingFor` callback's second argument.
 */
export type MediaPersistPricing =
  | { kind: 'image'; perImage: number }
  | { kind: 'video'; perSecond: number; durationSeconds: number; resolution: VideoResolution }
  | { kind: 'audio'; perSecond: number; durationSeconds: number };
