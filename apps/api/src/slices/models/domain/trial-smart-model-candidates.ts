import {
  ascendingByPrice,
  candidateEntry,
  classifierReserveLineItems,
  isEngineTextModel,
} from './smart-model-candidates.js';
import {
  TRIAL_MESSAGE_COST_CAP_NANO_USD,
  trialEligibility,
  trialMessageBillableNanoUsd,
} from './trial-eligibility.js';
import type { SmartModelCandidateEntry } from './smart-model-candidates.js';
import type { ModelDescriptor } from '@hushbox/shared';

/**
 * The Smart Model candidate list for one TRIAL send: every exposed,
 * engine-runnable text model that passes the trial eligibility gate
 * (non-premium: below the price quartile, old enough, affordable on the
 * minimal-exchange leg), sorted ascending by combined per-token billable rate,
 * with the cheapest doubling as the classifier model (and the runtime
 * fallback) — the same classifier chain as the paid list.
 *
 * Affordability basis, documented precisely — the trial variant of the paid
 * filter's balance check:
 * - Trial has NO wallet, so there is no balance read. The fixed 1¢
 *   per-message ceiling (`TRIAL_MESSAGE_COST_CAP_NANO_USD`) plays the role
 *   the wallet balance plays for a paid send.
 * - Everything is BILLABLE provider cost — the trial cap's basis (see
 *   `trial-eligibility.ts`) and the same basis the paid filter's classifier
 *   reserve gates a customer-facing balance with. Neither the reserve nor the
 *   per-message cost carries storage: a trial turn persists nothing, and the
 *   classifier's own prompt and answer never rest either (§Trial Usage).
 * - A candidate is kept iff
 *     classifier worst-case reserve + the ACTUAL message's billable cost ≤ 1¢,
 *   where the message cost is `trialMessageBillableNanoUsd` over the route's own
 *   `promptCharacterCount` (system prompt, custom instructions, history and
 *   input) plus the fixed minimum output allocation — the cap prices the
 *   classifier + answer
 *   combination per candidate, so the send stays under the ceiling whichever
 *   model the classifier picks. A reserve that alone meets the cap empties the
 *   list (nothing is left for any answer), and an unpriceable candidate
 *   (missing rates) is excluded fail-closed.
 * - An empty list is the caller's refusal signal: the send is too expensive
 *   for the trial, the same refusal class as a concrete over-cap model.
 */

export interface TrialSmartModelCandidatesInput {
  /** The exposed catalog (`listDescriptors`' already-filtered set). */
  readonly descriptors: readonly ModelDescriptor[];
  /** The reference clock for the premium-recency leg. */
  readonly nowMs: number;
  /**
   * The character count the SEND carries — system prompt, custom instructions,
   * history and the new input — as the route measured it for the turn budget.
   *
   * A count, not the text, and it arrives from the caller rather than being
   * recomputed here. Recomputing it locally is exactly the defect this replaced:
   * this file could see the system prompt, the history and the input, but NOT the
   * custom instructions, so the gate priced less than the definition it gates and
   * admitted sends over the 1¢ cap.
   */
  readonly promptCharacterCount: number;
}

export interface TrialSmartModelCandidates {
  /** The cheapest eligible candidate — the classifier model and runtime fallback. */
  readonly classifierModelId: string;
  /** Eligible candidates whose send fits the cap, ascending by billable rate. */
  readonly candidates: readonly SmartModelCandidateEntry[];
  /** The BILLABLE classifier reserve every candidate's cap check included. */
  readonly classifierWorstCaseNanoUsd: bigint;
}

export function buildTrialSmartModelCandidates(
  input: TrialSmartModelCandidatesInput
): TrialSmartModelCandidates | null {
  const eligibleSorted = input.descriptors
    .filter(
      (descriptor) =>
        isEngineTextModel(descriptor) &&
        trialEligibility(descriptor, input.descriptors, input.nowMs).eligible
    )
    .toSorted(ascendingByPrice);
  const classifier = eligibleSorted[0];
  if (classifier === undefined) return null;

  // The trial reserve is the classifier's billable provider cost. There is no
  // storage leg to add: the classifier's prompt and answer never rest, so the
  // list carries one item and summing it cannot pick up a storage charge.
  // `undefined` when the classifier lacks a per-token rate.
  const reserveItems = classifierReserveLineItems(classifier, eligibleSorted);
  /* v8 ignore next -- unreachable: the classifier is eligibleSorted[0], which passed trialEligibility's isPriceableForTrial (both per-token rates present), so classifierReserveLineItems cannot fail to price it; kept fail-closed */
  if (reserveItems === undefined) return null;
  let reserve = 0n;
  for (const item of reserveItems) {
    // Every classifier line item carries fixedNano; the ?? guards only the
    // optional NanoLineItem field type, never a real absence.
    /* v8 ignore next */
    reserve += item.fixedNano ?? 0n;
  }
  if (reserve >= TRIAL_MESSAGE_COST_CAP_NANO_USD) return null;

  const affordable = eligibleSorted.filter((descriptor) => {
    const messageCost = trialMessageBillableNanoUsd(descriptor, input.promptCharacterCount);
    /* v8 ignore next -- unreachable: trialEligibility already gated isPriceableForTrial (both per-token rates present), so trialMessageBillableNanoUsd cannot error for an eligible descriptor; kept fail-closed */
    if (messageCost.isErr()) return false;
    return reserve + messageCost.value <= TRIAL_MESSAGE_COST_CAP_NANO_USD;
  });
  if (affordable.length === 0) return null;

  return {
    classifierModelId: classifier.id,
    candidates: affordable.map((descriptor) => candidateEntry(descriptor)),
    classifierWorstCaseNanoUsd: reserve,
  };
}
