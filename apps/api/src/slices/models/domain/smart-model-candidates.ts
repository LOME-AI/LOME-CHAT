import {
  MINIMUM_OUTPUT_TOKENS,
  classifierLineItems,
  classifierReserveChars,
  estimateTokensForTier,
  outputCharsPerTokenForTier,
} from '@hushbox/shared';
import { applyMarkup } from '../../billing/index.js';
import { estimateRunCeilingNanoUsd, ratesFromPricing } from './estimate.js';
import { isTextModel } from './trial-eligibility.js';
import type { ClassifierStage, ModelDescriptor, NanoLineItem } from '@hushbox/shared';

/**
 * The Smart Model candidate menu for one paid send: every priceable exposed
 * text model, sorted ascending by combined per-token base price, with the
 * cheapest doubling as the classifier model (and the runtime fallback). Pure
 * over an exposed-catalog snapshot — the route reads the catalog and the wallet
 * balance, this decides.
 *
 * The menu is BALANCE-INDEPENDENT — this is the load-bearing property. The
 * priced candidate set never shrinks or grows with the wallet, so the estimator
 * that prices the definition (MAX over these candidates) yields a bounded
 * constant reserve — ONE context-window worth of the priciest model, the same
 * magnitude legacy reserved by classifying before pricing. A balance-scaled
 * menu made the reserve track the balance (a $100 wallet reserved ≈$100),
 * collapsing the concurrent-run capacity to ~1 and refusing subsequent sends.
 *
 * `balanceNanoUsd` is the payer's EFFECTIVE turn funding for this send: the
 * purchased-wallet balance for a solo paid turn, the owner-funded effective cap
 * `min(owner balance, conversation-budget remainder, member-budget remainder)`
 * for a group turn, or the remaining daily allowance for a free-tier turn — the
 * same effective figure admission gates on. It drives a single BINARY gate: the
 * turn is refused (null) only when the wallet cannot fund even the cheapest
 * candidate's floor — a genuinely under-funded wallet. The classifier
 * worst-case reserve (the REAL classifier call's upper bound: truncated-context
 * budget plus prompt overhead as input at a conservative 2 chars/token,
 * `CLASSIFIER_OUTPUT_TOKEN_CAP` output, at the classifier's rates) is added to
 * each candidate's floor for that gate. The floor prices the REALISTIC
 * minimum-viable answer (the actual prompt as input, `MINIMUM_OUTPUT_TOKENS` as
 * output) when a `promptInputTokens` basis is stamped, falling back to full
 * context on both legs otherwise.
 *
 * Admission remains the ONLY enforcement gate. A modestly funded wallet that
 * clears the binary gate but cannot cover the priciest candidate is refused at
 * admission on the bounded reserve — a 402 with no lingering hold, not the
 * balance-tracking reserve that caused the refuse-next-send flood.
 *
 * An unpriceable model (missing per-token rates or context length) is excluded
 * from the menu, so the estimator's fail-closed arm never sees one.
 */

/** Conservative chars-per-token for the classifier-input reserve (overestimate);
 * the shared conservative constant is the single source (equals 2). The reserve
 * itself divides via {@link estimateTokensForTier} — this alias is exported for
 * callers that need the ratio value directly. */
export { CHARS_PER_TOKEN_CONSERVATIVE as CLASSIFIER_CHARS_PER_TOKEN } from '@hushbox/shared';

export interface SmartModelCandidatesInput {
  /** The exposed catalog (`listDescriptors`' already-filtered set). */
  readonly descriptors: readonly ModelDescriptor[];
  /** The payer's effective turn funding in nano-USD (purchased balance,
   * owner-funded cap, or free allowance — the figure admission gates on). */
  readonly balanceNanoUsd: bigint;
  /**
   * The turn's estimated prompt input-token count. When present the binary
   * gate's affordability floor prices the REALISTIC minimum-viable answer (the
   * actual prompt as input, `MINIMUM_OUTPUT_TOKENS` as output) — matching
   * admission's corrected basis — instead of a full-context worst case, so a
   * free-tier turn clears the gate. Absent ⇒ the full-context floor (the
   * pre-stamp fail-closed behavior). It shapes only the gate threshold, never
   * the balance-independent menu.
   */
  readonly promptInputTokens?: number;
}

export interface SmartModelCandidateEntry {
  readonly id: string;
  readonly description?: string;
}

export interface SmartModelCandidates {
  /** The cheapest text candidate — the classifier model and runtime fallback. */
  readonly classifierModelId: string;
  /** Affordable candidates, ascending by combined base price. */
  readonly candidates: readonly SmartModelCandidateEntry[];
  /** The classifier reserve every candidate's affordability was checked against. */
  readonly classifierWorstCaseNanoUsd: bigint;
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

/** input + output per-token base rates — the price candidates sort on. */
function combinedBasePrice(descriptor: ModelDescriptor): bigint {
  const input = descriptor.pricing['inputPerToken'];
  const output = descriptor.pricing['outputPerToken'];
  return (typeof input === 'bigint' ? input : 0n) + (typeof output === 'bigint' ? output : 0n);
}

/**
 * The affordability floor for one candidate, marked up once. With a stamped
 * prompt basis it is the REALISTIC minimum-viable answer — the actual prompt as
 * input, `MINIMUM_OUTPUT_TOKENS` as output — the same corrected basis admission
 * prices against; a candidate that cannot fund even this is excluded (mirroring
 * `turnMaxOutputTokens` returning undefined below its minimum-output threshold).
 * Without a prompt basis it falls back to the full-context worst case.
 */
function turnCeilingNanoUsd(
  descriptor: ModelDescriptor,
  promptInputTokens: number | undefined
): bigint | undefined {
  const contextLength = descriptor.limits['contextLength'];
  if (contextLength === undefined) return undefined;
  const inputTokens =
    promptInputTokens === undefined ? contextLength : Math.min(contextLength, promptInputTokens);
  const outputTokens =
    promptInputTokens === undefined
      ? contextLength
      : Math.min(contextLength, MINIMUM_OUTPUT_TOKENS);
  const ceiling = estimateRunCeilingNanoUsd(
    descriptor.pricing,
    { kind: 'tokens', inputTokens, outputTokens },
    { maxFanOutWidth: 1, maxSteps: 1, maxIterations: 1 }
  );
  return ceiling.isOk() ? ceiling.value : undefined;
}

/**
 * The Smart-Model classifier pre-reserve as shared-core {@link NanoLineItem}s:
 * the provider `classifier-tokens` item (marks up) and the pass-through
 * `classifier-storage` item (never marks up), priced through the shared
 * `classifierLineItems` so the reserve's cost formula lives ONCE in the core.
 * The classifier's full truncated-context budget plus the exact prompt overhead
 * (rendered against the candidate list — an upper bound on what the classifier
 * sees once affordability shrinks the list) is the input, a fixed output cap the
 * output, at the classifier's rates; `outputCharsPerToken` (tier-dependent)
 * sizes the storage leg. `undefined` when the classifier lacks a plain per-token
 * rate. Shared with the trial derivation (whose 1¢ gate sums both items, storage
 * included) and with admission (which marks up the provider item and adds
 * storage only when the turn persists).
 */
export function classifierReserveLineItems(
  classifier: ModelDescriptor,
  // Only id + description are read (the classifier prompt line), so this
  // accepts the estimator's stamped candidate list as well as full descriptors.
  textCatalog: readonly { readonly id: string; readonly description?: string | undefined }[],
  outputCharsPerToken: number
): readonly NanoLineItem[] | undefined {
  const reserveChars = classifierReserveChars(
    textCatalog.map((entry) => ({ id: entry.id, description: entry.description ?? '' }))
  );
  const stage: ClassifierStage = {
    pricing: ratesFromPricing(classifier.pricing),
    // Conservative reserve (2 chars/token, deliberate overestimate) via the shared
    // helper: the classifier reserve is tier-independent on its input leg and always
    // uses the conservative ratio (see CLASSIFIER_CHARS_PER_TOKEN).
    inputTokens: BigInt(estimateTokensForTier('trial', reserveChars)),
    inputChars: reserveChars,
  };
  const items = classifierLineItems(stage, outputCharsPerToken);
  return items.ok ? items.value : undefined;
}

/**
 * The classifier call's worst-case BASE (pre-markup) PROVIDER cost — the
 * `classifier-tokens` component of {@link classifierReserveLineItems}, excluding
 * storage. This is the amount admission and the paid affordability filter mark
 * up (storage is pass-through and is added, unmarked, only where the turn
 * persists). `undefined` when the classifier lacks a plain per-token rate.
 */
export function classifierWorstCaseBaseNanoUsd(
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
  return items?.find((item) => item.marksUp)?.fixedNano;
}

/** The paid filter's classifier reserve: the worst case, customer-priced. */
function classifierWorstCaseNanoUsd(
  classifier: ModelDescriptor,
  textCatalog: readonly ModelDescriptor[]
): bigint | undefined {
  const base = classifierWorstCaseBaseNanoUsd(classifier, textCatalog);
  return base === undefined ? undefined : applyMarkup(base);
}

export function ascendingByPrice(a: ModelDescriptor, b: ModelDescriptor): number {
  const left = combinedBasePrice(a);
  const right = combinedBasePrice(b);
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function candidateEntry(descriptor: ModelDescriptor): SmartModelCandidateEntry {
  return {
    id: descriptor.id,
    ...(descriptor.description === undefined ? {} : { description: descriptor.description }),
  };
}

export function buildSmartModelCandidates(
  input: SmartModelCandidatesInput
): SmartModelCandidates | null {
  const sortedText = input.descriptors
    .filter((descriptor) => isEngineTextModel(descriptor))
    .toSorted(ascendingByPrice);
  const classifier = sortedText[0];
  if (classifier === undefined) return null;

  const reserve = classifierWorstCaseNanoUsd(classifier, sortedText);
  if (reserve === undefined) return null;

  // The priced candidate menu is BALANCE-INDEPENDENT: every priceable
  // engine-text model, never a balance-scaled subset. This is what keeps the
  // admission reserve a bounded constant — the estimator's MAX over these
  // candidates prices ONE context-window worth of the priciest model, the same
  // magnitude legacy reserved by classifying first. A balance-scaled menu made
  // the reserve climb toward the whole wallet (a $100 wallet reserved ≈$100,
  // supporting only ~1 in-flight run). Unpriceable models are excluded here so
  // the estimator's fail-closed arm never sees one.
  const menu = sortedText.flatMap((descriptor) => {
    const ceiling = turnCeilingNanoUsd(descriptor, input.promptInputTokens);
    return ceiling === undefined ? [] : [{ descriptor, ceiling }];
  });
  if (menu.length === 0) return null;

  // Affordability is a single BINARY gate, not a menu filter: the turn is
  // refused only when the wallet cannot fund even the cheapest candidate's
  // realistic floor — a genuinely under-funded wallet. The balance decides
  // pass/refuse, never the SHAPE of the menu. A modestly funded wallet that
  // passes here but cannot cover the priciest candidate is refused later by
  // admission on the bounded (not balance-tracking) reserve.
  const affordable = menu.some((item) => input.balanceNanoUsd >= reserve + item.ceiling);
  if (!affordable) return null;

  return {
    classifierModelId: classifier.id,
    candidates: menu.map((item) => candidateEntry(item.descriptor)),
    classifierWorstCaseNanoUsd: reserve,
  };
}
