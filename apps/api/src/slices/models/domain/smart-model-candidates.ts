import { outputCharsPerTokenForTier } from '@hushbox/shared/affordability/estimate/pre-adapters';
import {
  admitSmartModel,
  classifierReserveLineItems,
} from '@hushbox/shared/affordability/estimate/smart-model-affordability';
import { isTextModel } from './trial-eligibility.js';
import type { ModelDescriptor, Pricing } from '@hushbox/shared';
import type {
  SmartModelPoolCandidate,
  SmartModelStorageContext,
} from '@hushbox/shared/affordability/estimate/smart-model-affordability';

/**
 * The Smart Model candidate menu for one paid send: the ELIGIBLE subset of the
 * exposed text catalog for this payer, each entry carrying its OWN affordable
 * answer cap `cap(m)`, ordered ascending by `maxCallCost`, with the cheapest model
 * PER TOKEN running the classification. Pure over
 * an exposed-catalog snapshot plus the payer's effective balance. The affordability
 * gate lives ONCE in the shared money layer ({@link admitSmartModel}), so the
 * client affordability preflight and this server admission builder can never
 * disagree (the biconditional).
 *
 * The menu carries the pool MINUS its high-cost outliers (`outlier(m)`, BILLING.md
 * §Smart Model 3): the hold is a MAX over the candidates, so one extreme candidate
 * would set the hold for every turn the pool appears in and shrink what every other
 * candidate can do. An excluded model is not removed from the product — an explicit
 * pick still runs it, and the exclusion is balance-independent, taken over the
 * priceable catalog pool rather than the eligible subset.
 *
 * The menu is BALANCE-DEPENDENT: a candidate is eligible iff it can afford at least
 * `MINIMUM_OUTPUT_TOKENS` of answer at its own rate after the classifier reserve
 * and its input; the classifier only ever routes among the eligible set. A $0
 * wallet cannot fund even the classifier reserve, so Smart Model is refused
 * (`null` → 402). A well-funded wallet makes every candidate reach its full
 * context, and the admission reserve (MAX over the subset) is one context-window
 * worth of the priciest candidate — balance-independent, so concurrency is not
 * regressed.
 *
 * `balanceNanoUsd` is the payer's EFFECTIVE turn funding (cushion-inclusive) for
 * this send: the purchased-wallet spendable for a solo paid turn, the owner-funded
 * effective cap for a group turn, or the remaining daily allowance for a free-tier
 * turn — the same effective figure admission gates on. `storage` (present when the
 * turn persists) folds the answer/prompt storage into each cap so it matches what
 * the admission estimator holds — no storage-edge affordable-then-402. An
 * unpriceable model (missing per-token rates or context length) is excluded.
 */

/** Conservative chars-per-token for the classifier-input reserve (overestimate);
 * the shared conservative constant is the single source (equals 2). The reserve
 * itself divides via the shared `estimateTokensForTier` helper — this alias is
 * exported for callers that need the ratio value directly. */
export { CHARS_PER_TOKEN_CONSERVATIVE as CLASSIFIER_CHARS_PER_TOKEN } from '@hushbox/shared/affordability/constants';

/** The classifier pre-reserve line items — the single shared home; re-exported so
 * the admission estimator (`estimate-run`) reads the SAME reserve formula. */
export { classifierReserveLineItems } from '@hushbox/shared/affordability/estimate/smart-model-affordability';

export interface SmartModelCandidatesInput {
  /** The exposed catalog (`listDescriptors`' already-filtered set). */
  readonly descriptors: readonly ModelDescriptor[];
  /** The payer's effective turn funding in nano-USD (purchased balance,
   * owner-funded cap, or free allowance — the figure admission gates on). */
  readonly balanceNanoUsd: bigint;
  /**
   * The turn's estimated prompt input-token count. When present the
   * affordability floor prices the REALISTIC minimum-viable answer (the actual
   * prompt as input, `MINIMUM_OUTPUT_TOKENS` as output) — matching admission's
   * corrected basis — instead of a full-context worst case, so a free-tier turn
   * clears the gate on a cheap model. Absent ⇒ the full-context floor (the
   * pre-stamp fail-closed behavior).
   */
  readonly promptInputTokens?: number;
  /**
   * The persisting-turn storage context (tier output ratio + prompt char count)
   * the per-candidate caps price against, so each cap covers the answer/prompt
   * storage the admission estimator holds — the free-tier keystone. Absent for a
   * no-persist / trial build (provider cost only).
   */
  readonly storage?: SmartModelStorageContext;
}

export interface SmartModelCandidateEntry {
  readonly id: string;
  readonly description?: string;
  /** `cap(m)`: this candidate's own affordable answer-token ceiling (the most
   * tokens the reservation buys at its rate, bounded by its context). The
   * execution applies it for THIS model; the estimator reserves it at this cap. */
  readonly maxOutputTokens?: number;
}

export interface SmartModelCandidates {
  /** The cheapest text model per token — the model that RUNS the classification.
   * Not necessarily one of `candidates`: the two ride different orders, and an
   * enormous-capacity model can be both the cheapest per token and an outlier. */
  readonly classifierModelId: string;
  /** The ELIGIBLE subset (each affords ≥ MINIMUM answer) minus the pool's
   * outliers, ascending by `maxCallCost`, each carrying its own
   * `maxOutputTokens = cap(m)`. The classifier can only route among these, so no
   * unaffordable model is ever reachable. */
  readonly candidates: readonly SmartModelCandidateEntry[];
  /** The classifier reserve every candidate's cap was sized against. */
  readonly classifierWorstCaseNanoUsd: bigint;
  /** The admission reserve R = MAX over eligible of the per-candidate reserve. */
  readonly reserveNanoUsd: bigint;
}

/**
 * A candidate must be a model the engine can RUN as a text turn: text must be
 * an accepted input (other input modalities are allowed, since Smart Model only
 * ever sends text) AND the single output must be text. This is exactly
 * `isTextModel`/`isRunnableModelShape` — a text+image-INPUT (vision) model
 * qualifies, while text+image-OUTPUT and multi-output models stay excluded.
 * Shared with the trial candidate derivation (same engine, same constraint).
 */
export function isEngineTextModel(descriptor: ModelDescriptor): boolean {
  return isTextModel(descriptor);
}

/** input + output per-token billable rates — the price the classifier pick sorts on. */
function combinedRate(descriptor: ModelDescriptor): bigint {
  const input = descriptor.pricing['inputPerToken'];
  const output = descriptor.pricing['outputPerToken'];
  return (typeof input === 'bigint' ? input : 0n) + (typeof output === 'bigint' ? output : 0n);
}

/**
 * The classifier call's worst-case BILLABLE provider cost — the
 * `classifier-tokens` component of the shared {@link classifierReserveLineItems},
 * excluding storage. Rates are billable at catalog ingestion, so this figure
 * is already customer-priced: admission and the paid affordability filter use
 * it as-is (storage is pass-through and is added, unmarked, only where the
 * turn persists). `undefined` when the classifier lacks a plain per-token rate.
 */
export function classifierWorstCaseNanoUsd(
  classifier: ModelDescriptor,
  textCatalog: readonly { readonly id: string; readonly description?: string | undefined }[]
): bigint | undefined {
  // The output-storage ratio is irrelevant to the marked-up token cost, so the
  // conservative trial ratio is passed to satisfy the core; its storage item is
  // discarded here. Storage-aware callers use classifierReserveLineItems.
  const items = classifierReserveLineItems(
    classifier,
    textCatalog,
    outputCharsPerTokenForTier('trial')
  );
  return items?.find((item) => item.kind === 'provider')?.fixedNano;
}

/**
 * The engine order: combined per-token rate, IDENTIFIER tiebreak. The tiebreak is
 * load-bearing rather than tidy — the catalog read is a whole-table select, so
 * without it two equally cheap models would let database row order decide which
 * model classifies every `auto` turn (§Smart Model 1).
 */
export function ascendingByPrice(a: ModelDescriptor, b: ModelDescriptor): number {
  const left = combinedRate(a);
  const right = combinedRate(b);
  if (left < right) return -1;
  if (left > right) return 1;
  if (a.id < b.id) return -1;
  return a.id > b.id ? 1 : 0;
}

/** One descriptor → the id/description candidate entry the trial derivation stamps. */
export function candidateEntry(descriptor: ModelDescriptor): SmartModelCandidateEntry {
  return {
    id: descriptor.id,
    ...(descriptor.description === undefined ? {} : { description: descriptor.description }),
  };
}

export interface EffortClassifierPick {
  /** The cheapest priceable engine-text model — the effort classifier. */
  readonly classifierModelId: string;
  /**
   * The classifier call's worst-case billable reserve, with the prompt
   * overhead rendered against the single pinned candidate — the same basis
   * admission's smartModel reserve prices the node at.
   */
  readonly classifierWorstCaseNanoUsd: bigint;
}

/**
 * The classifier pick for a PINNED-model auto-effort turn: the model is the
 * user's own choice (a single candidate — no routing), so only the effort
 * dimension classifies, and the classifier is the cheapest priceable
 * engine-text model in the exposed catalog — the same derivation Smart Model
 * uses. `null` when no text model can price the call; the caller refuses the
 * send with the typed classifier-unavailable code rather than picking an
 * effort itself.
 */
export function pickEffortClassifier(
  descriptors: readonly ModelDescriptor[],
  pinned: ModelDescriptor
): EffortClassifierPick | null {
  const classifier = descriptors
    .filter((descriptor) => isEngineTextModel(descriptor))
    .toSorted(ascendingByPrice)[0];
  if (classifier === undefined) return null;
  const reserve = classifierWorstCaseNanoUsd(classifier, [pinned]);
  if (reserve === undefined) return null;
  return { classifierModelId: classifier.id, classifierWorstCaseNanoUsd: reserve };
}

/** One exposed descriptor → the shared affordability gate's poolable shape. */
function toPoolCandidate(descriptor: ModelDescriptor): SmartModelPoolCandidate {
  const pricing: Pricing = descriptor.pricing;
  const contextLength = descriptor.limits['contextLength'];
  const maxOutputTokens = descriptor.limits['maxOutputTokens'];
  return {
    id: descriptor.id,
    ...(descriptor.description === undefined ? {} : { description: descriptor.description }),
    pricing,
    ...(contextLength === undefined ? {} : { contextLength }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
  };
}

export function buildSmartModelCandidates(
  input: SmartModelCandidatesInput
): SmartModelCandidates | null {
  const pool = input.descriptors
    .filter((descriptor) => isEngineTextModel(descriptor))
    .map((descriptor) => toPoolCandidate(descriptor));
  // Per-candidate affordable admission over the tier-effective balance: each
  // eligible candidate (cap(m) ≥ MINIMUM) carries its own cap(m); an empty
  // eligible set ⇒ a genuinely under-funded wallet, refused outright (402).
  const admission = admitSmartModel(
    pool,
    input.balanceNanoUsd,
    input.promptInputTokens,
    input.storage
  );
  if (admission === null) return null;
  return {
    classifierModelId: admission.classifierModelId,
    candidates: admission.candidates,
    classifierWorstCaseNanoUsd: admission.classifierWorstCaseNanoUsd,
    reserveNanoUsd: admission.reserveNanoUsd,
  };
}
