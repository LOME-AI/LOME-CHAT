/**
 * The Smart Model per-candidate affordability gate — the ONE implementation both
 * the server admission builder (`buildSmartModelCandidates`) and the client
 * affordability preflight (`usePromptBudget`) reduce through. {@link admitSmartModel}
 * gives each eligible candidate its OWN affordable answer cap `cap(m)` (the most
 * tokens the reservation buys at that model's rate, bounded by its context) over
 * the tier-EFFECTIVE balance; the classifier only ever routes among the eligible
 * set, and the admission hold is the MAX over it — `≤ effBalance` by construction.
 * {@link smartModelMinimumRequiredNanoUsd} is the balance-independent threshold
 * below which the eligible set is empty (a $0 wallet is refused); the client
 * denies below it, so client verdict and server null-ness cannot disagree (the
 * biconditional). Costs are priced EXACTLY as the admission estimator (billable
 * rates + storage, no fee math), so an admitted subset is never refused at
 * admission.
 *
 * {@link priceSmartModelPool} remains the internal balance-independent pricing
 * (classifier pick + sort + priceable set) both entry points build on.
 */

import { MINIMUM_OUTPUT_TOKENS } from '../constants.js';
import { estimateTokensForTier, outputCharsPerTokenForTier } from './pre-adapters.js';
import { classifierLineItems, classifierReserveChars } from './classifier-line-item.js';
import { estimateRunCeilingNanoUsd, ratesFromPricing } from './run-ceiling.js';
import { STORAGE_COST_PER_CHARACTER_NANO } from './storage-rate.js';
import type { ClassifierStage, NanoLineItem } from './types.js';
import type { Pricing } from '../model-descriptor.js';

/**
 * The Smart-Model classifier pre-reserve as shared-core {@link NanoLineItem}s:
 * the billable provider `classifier-tokens` item and the pass-through
 * `classifier-storage` item, priced through the shared
 * `classifierLineItems` so the reserve's cost formula lives ONCE. The
 * classifier's full truncated-context budget plus the exact prompt overhead
 * (rendered against the candidate list — an upper bound on what the classifier
 * sees once affordability shrinks the list) is the input, a fixed output cap the
 * output, at the classifier's rates; `outputCharsPerToken` (tier-dependent) sizes
 * the storage leg. `undefined` when the classifier lacks a plain per-token rate.
 * Shared with admission (which takes the provider item as-is and adds storage
 * only when the turn persists) and the trial derivation.
 */
export function classifierReserveLineItems(
  classifier: { readonly pricing: Pricing },
  // Only id + description are read (the classifier prompt line), so this accepts
  // the estimator's stamped candidate list as well as full descriptors.
  textCatalog: readonly { readonly id: string; readonly description?: string | undefined }[],
  outputCharsPerToken: number
): readonly NanoLineItem[] | undefined {
  const reserveChars = classifierReserveChars(
    textCatalog.map((entry) => ({ id: entry.id, description: entry.description ?? '' }))
  );
  const stage: ClassifierStage = {
    pricing: ratesFromPricing(classifier.pricing),
    // Conservative reserve (2 chars/token, deliberate overestimate) via the
    // shared helper: the classifier reserve is tier-independent on its input leg
    // and always uses the conservative ratio.
    inputTokens: BigInt(estimateTokensForTier('trial', reserveChars)),
    inputChars: reserveChars,
  };
  const items = classifierLineItems(stage, outputCharsPerToken);
  return items.ok ? items.value : undefined;
}

/** A poolable Smart Model text candidate: enough to sort, reserve, and floor it. */
export interface SmartModelPoolCandidate {
  readonly id: string;
  readonly description?: string;
  /** Per-token catalog rates (nano-USD). Missing rates sort as 0 and fail closed. */
  readonly pricing: Pricing;
  /** The model's context-token limit; absent ⇒ unpriceable floor, excluded. */
  readonly contextLength?: number;
  /**
   * The model's provider completion ceiling (`descriptor.limits
   * .maxOutputTokens`). Bounds every answer cap and worst-case output leg —
   * strict tightening; absent ⇒ the context length alone bounds.
   */
  readonly maxOutputTokens?: number;
}

/** A candidate that priced a realistic floor, kept for the affordability filter. */
export interface PricedSmartModelCandidate {
  readonly id: string;
  readonly description?: string;
  /** The realistic minimum-viable-answer floor at billable rates. */
  readonly floorNanoUsd: bigint;
}

export interface PricedSmartModelPool {
  /** The cheapest text candidate — the classifier model and runtime fallback. */
  readonly classifierModelId: string;
  /** The classifier reserve every candidate's affordability is checked against. */
  readonly classifierWorstCaseNanoUsd: bigint;
  /** Priceable candidates, ascending by combined base price. */
  readonly priced: readonly PricedSmartModelCandidate[];
  /**
   * The reserve plus the cheapest candidate's realistic floor. Retained as
   * internal balance-independent pricing; the live affordability threshold is
   * {@link smartModelMinimumRequiredNanoUsd} (per-candidate, storage-inclusive).
   */
  readonly minimumRequiredNanoUsd: bigint;
}

export interface SmartModelCandidateId {
  readonly id: string;
  readonly description?: string;
}

/** input + output per-token base rates — the price candidates sort on. */
function combinedBasePrice(candidate: SmartModelPoolCandidate): bigint {
  const input = candidate.pricing['inputPerToken'];
  const output = candidate.pricing['outputPerToken'];
  return (typeof input === 'bigint' ? input : 0n) + (typeof output === 'bigint' ? output : 0n);
}

function ascendingByPrice(a: SmartModelPoolCandidate, b: SmartModelPoolCandidate): number {
  const left = combinedBasePrice(a);
  const right = combinedBasePrice(b);
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** The paid filter's classifier reserve: the worst-case billable provider cost
 * (rates are billable at ingestion — no fee math here). */
function classifierWorstCaseNanoUsd(
  classifier: { readonly pricing: Pricing },
  textCatalog: readonly SmartModelCandidateId[]
): bigint | undefined {
  const items = classifierReserveLineItems(
    classifier,
    textCatalog,
    outputCharsPerTokenForTier('trial')
  );
  return items?.find((item) => item.kind === 'provider')?.fixedNano;
}

/**
 * The affordability floor for one candidate, at billable rates. With a stamped
 * prompt basis it is the REALISTIC minimum-viable answer — the actual prompt as
 * input, `MINIMUM_OUTPUT_TOKENS` as output — the same corrected basis admission
 * prices against; without a basis it falls back to the full-context worst case.
 * `undefined` when the candidate lacks a context limit or per-token rate.
 */
function floorNanoUsd(
  candidate: SmartModelPoolCandidate,
  promptInputTokens: number | undefined
): bigint | undefined {
  const contextLength = candidate.contextLength;
  if (contextLength === undefined) return undefined;
  const inputTokens =
    promptInputTokens === undefined ? contextLength : Math.min(contextLength, promptInputTokens);
  // The output leg never prices past the provider completion ceiling — the
  // model physically cannot emit beyond it (strict tightening of the floor).
  const outputContextBound =
    promptInputTokens === undefined
      ? contextLength
      : Math.min(contextLength, MINIMUM_OUTPUT_TOKENS);
  const outputTokens =
    candidate.maxOutputTokens === undefined
      ? outputContextBound
      : Math.min(outputContextBound, candidate.maxOutputTokens);
  const ceiling = estimateRunCeilingNanoUsd(
    candidate.pricing,
    { kind: 'tokens', inputTokens, outputTokens },
    { maxFanOutWidth: 1, maxSteps: 1, maxIterations: 1 }
  );
  return ceiling.ok ? ceiling.value : undefined;
}

/**
 * Prices the Smart Model pool balance-INDEPENDENTLY: the cheapest text candidate
 * is the classifier and its worst-case reserve is its billable provider cost; every
 * priceable candidate carries its realistic floor. `null` when no text candidate
 * exists, the cheapest lacks a per-token rate (an unpriceable classifier fails
 * the whole list closed), or no candidate prices a floor. The candidate list
 * passed in must already be filtered to engine-runnable text models.
 */
export function priceSmartModelPool(
  candidates: readonly SmartModelPoolCandidate[],
  promptInputTokens?: number
): PricedSmartModelPool | null {
  const sorted = candidates.toSorted(ascendingByPrice);
  const classifier = sorted[0];
  if (classifier === undefined) return null;

  const reserve = classifierWorstCaseNanoUsd(classifier, sorted);
  if (reserve === undefined) return null;

  let minFloor: bigint | undefined;
  const priced = sorted.flatMap((candidate): PricedSmartModelCandidate[] => {
    const floor = floorNanoUsd(candidate, promptInputTokens);
    if (floor === undefined) return [];
    if (minFloor === undefined || floor < minFloor) minFloor = floor;
    return [
      {
        id: candidate.id,
        ...(candidate.description === undefined ? {} : { description: candidate.description }),
        floorNanoUsd: floor,
      },
    ];
  });
  if (priced.length === 0) return null;
  /* v8 ignore next -- minFloor is assigned whenever priced is non-empty; this
     only narrows bigint | undefined for the compiler, never a runtime path */
  if (minFloor === undefined) return null;

  return {
    classifierModelId: classifier.id,
    classifierWorstCaseNanoUsd: reserve,
    priced,
    minimumRequiredNanoUsd: reserve + minFloor,
  };
}

/** One eligible Smart Model candidate carrying its OWN affordable answer cap —
 * the most output tokens the reservation buys at that model's rate, bounded by
 * its remaining context. Each runs at its own `maxOutputTokens`; the classifier
 * only ever picks from this eligible set. */
export interface SmartModelCappedCandidate {
  readonly id: string;
  readonly description?: string;
  /** `cap(m)`: the budget- and context-bounded answer-token ceiling for model m. */
  readonly maxOutputTokens: number;
}

/**
 * The per-candidate Smart Model admission over the tier-EFFECTIVE (cushion-
 * inclusive) balance — the ONE gate both server admission and the client
 * preflight reduce through. For each priceable candidate m (against
 * `affordableBudget = effBalance − classifierReserve`):
 *
 *   `cap(m) = min( floor((affordableBudget − inputCost(m)) / outputRate(m)),
 *                  remainingContext(m), maxOutputTokens(m) )`
 *
 * — the most output tokens m's rate affords, capped by its context and its
 * provider completion ceiling when the catalog carries one (a cheap
 * model reaches its full physical ceiling; a pricey one is budget-limited). Model m is
 * ELIGIBLE iff `cap(m) ≥ MINIMUM_OUTPUT_TOKENS`; the returned `candidates` are
 * exactly the eligible set, each with its own `cap(m)`, so the classifier can
 * never route to an unaffordable model. The admission hold is
 *   `R = MAX over eligible ( classifierReserve + inputCost(m) + cap(m)×outputRate(m) )`
 * which is `≤ effBalance` by construction (each term either spends the whole
 * affordableBudget or is bounded by m's full-context cost, so a well-funded
 * wallet's reserve stays balance-INDEPENDENT and concurrency is preserved). No
 * under-reserve: the picked model's actual cost `≤ cap(m)×rate ≤ R`. Reasoning
 * rides INSIDE `cap(m)` (`max_tokens = B + H`), so effort adds no cost leg.
 *
 * `null` when no candidate can afford a minimum answer (refuse the send) — the
 * $0-wallet block rests on the classifier reserve alone exceeding the balance.
 * Rates are billable (fee-baked at ingestion); provider cost only — the pre-existing
 * floor-vs-worst-case storage asymmetry (documented at the admission estimator)
 * is unchanged. `promptInputTokens` bounds the input leg at the real prompt.
 */
export function admitSmartModel(
  candidates: readonly SmartModelPoolCandidate[],
  effBalanceNanoUsd: bigint,
  promptInputTokens?: number,
  storage?: SmartModelStorageContext
): SmartModelAdmission | null {
  const pool = priceSmartModelPool(candidates, promptInputTokens);
  if (pool === null) return null;
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const classifier = byId.get(pool.classifierModelId);
  // The fixed reserve every candidate's cap is sized against: the billable
  // classifier provider cost, its pass-through storage, and the one-off input
  // (prompt) storage — all storage-inclusive when the turn persists, so the cap
  // math matches what the admission estimator actually holds (no storage-edge
  // affordable-then-402, the free-tier keystone).
  /* v8 ignore next 2 -- classifierModelId is sorted[0].id of `candidates`, so
     the byId lookup cannot miss; the ternary only narrows undefined for the compiler */
  const classifierStorage =
    classifier === undefined ? 0n : classifierStorageNanoUsd(classifier, candidates, storage);
  const fixedReserve =
    pool.classifierWorstCaseNanoUsd + classifierStorage + inputStorageNanoUsd(storage);
  const context: CapContext = {
    promptInputTokens,
    outputStoragePerToken: outputStoragePerTokenNanoUsd(storage),
    affordableBudget: effBalanceNanoUsd - fixedReserve,
  };
  const eligible: SmartModelCappedCandidate[] = [];
  let reserveNanoUsd = 0n;
  for (const priced of pool.priced) {
    const raw = byId.get(priced.id);
    /* v8 ignore next -- priced ⊆ candidates, so the byId lookup cannot miss;
       narrows undefined for the compiler, never a runtime path */
    const capped = raw === undefined ? undefined : evaluateCandidate(raw, priced, context);
    if (capped === undefined) continue;
    eligible.push(capped.candidate);
    const reserve = fixedReserve + capped.costNanoUsd;
    if (reserve > reserveNanoUsd) reserveNanoUsd = reserve;
  }
  if (eligible.length === 0) return null;
  return {
    classifierModelId: pool.classifierModelId,
    classifierWorstCaseNanoUsd: pool.classifierWorstCaseNanoUsd,
    candidates: eligible,
    reserveNanoUsd,
  };
}

/** The balance-derived inputs a per-candidate cap prices against. */
interface CapContext {
  readonly promptInputTokens: number | undefined;
  readonly outputStoragePerToken: bigint;
  readonly affordableBudget: bigint;
}

/** One priceable candidate's eligible cap + provider/storage cost, or `undefined`
 * when it cannot fund a minimum answer (excluded from the classifier's set). */
function evaluateCandidate(
  raw: SmartModelPoolCandidate,
  priced: PricedSmartModelCandidate,
  context: CapContext
): { readonly candidate: SmartModelCappedCandidate; readonly costNanoUsd: bigint } | undefined {
  const basis = candidateBasis(raw, context.promptInputTokens, context.outputStoragePerToken);
  if (basis === undefined) return undefined;
  const cap = candidateCapTokens(basis, context.affordableBudget);
  if (cap < MINIMUM_OUTPUT_TOKENS) return undefined;
  return {
    candidate: {
      id: priced.id,
      ...(priced.description === undefined ? {} : { description: priced.description }),
      maxOutputTokens: cap,
    },
    costNanoUsd: candidateCost(basis, cap),
  };
}

/** The persisting-turn storage context the per-candidate caps price against —
 * the SAME tier-sized output ratio and prompt-char count the admission estimator
 * bills, so client and server derive identical caps. Absent ⇒ provider cost only
 * (no-persist / trial). */
export interface SmartModelStorageContext {
  /** Output-storage chars per answer token (tier-sized: 2 paid, 4 free). */
  readonly outputCharsPerToken: number;
  /** The prompt input-storage char count (charged once, definition-level). */
  readonly inputChars: number;
}

export interface SmartModelAdmission {
  /** The cheapest text candidate — the classifier model and runtime fallback. */
  readonly classifierModelId: string;
  /** The classifier's billable provider reserve (storage excluded). */
  readonly classifierWorstCaseNanoUsd: bigint;
  /** The ELIGIBLE subset (`cap(m) ≥ MINIMUM_OUTPUT_TOKENS`), ascending by price. */
  readonly candidates: readonly SmartModelCappedCandidate[];
  /** `R = MAX over eligible ( fixedReserve + inputCost(m) + cap(m)×outputRate(m) )`; ≤ effBalance. */
  readonly reserveNanoUsd: bigint;
}

/**
 * The balance-INDEPENDENT affordability threshold: the effective balance BELOW
 * which {@link admitSmartModel} returns `null` (the eligible subset is empty).
 * `= MIN over priceable m ( fixedReserve + inputCost(m) + MINIMUM_OUTPUT_TOKENS ×
 * outputRate(m) )` over candidates whose remaining context fits a minimum answer,
 * all storage-inclusive (the SAME `storage` context both sides pass). The client
 * prices Smart Model at this figure and denies below it, so client verdict and
 * server null-ness cannot disagree (the biconditional). `null` when nothing prices.
 */
export function smartModelMinimumRequiredNanoUsd(
  candidates: readonly SmartModelPoolCandidate[],
  promptInputTokens?: number,
  storage?: SmartModelStorageContext
): bigint | null {
  const pool = priceSmartModelPool(candidates, promptInputTokens);
  if (pool === null) return null;
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const classifier = byId.get(pool.classifierModelId);
  /* v8 ignore next 2 -- classifierModelId is sorted[0].id of `candidates`, so
     the byId lookup cannot miss; the ternary only narrows undefined for the compiler */
  const classifierStorage =
    classifier === undefined ? 0n : classifierStorageNanoUsd(classifier, candidates, storage);
  const fixedReserve =
    pool.classifierWorstCaseNanoUsd + classifierStorage + inputStorageNanoUsd(storage);
  const outputStoragePerToken = outputStoragePerTokenNanoUsd(storage);
  let minimum: bigint | undefined;
  for (const priced of pool.priced) {
    const raw = byId.get(priced.id);
    /* v8 ignore next 2 -- priced ⊆ candidates, so the byId lookup cannot miss;
       narrows undefined for the compiler, never a runtime path */
    const basis =
      raw === undefined ? undefined : candidateBasis(raw, promptInputTokens, outputStoragePerToken);
    if (basis === undefined || basis.remaining < MINIMUM_OUTPUT_TOKENS) continue;
    const threshold = fixedReserve + candidateCost(basis, MINIMUM_OUTPUT_TOKENS);
    if (minimum === undefined || threshold < minimum) minimum = threshold;
  }
  return minimum ?? null;
}

/** Output-storage cost per answer token (0 when the turn does not persist). */
function outputStoragePerTokenNanoUsd(storage: SmartModelStorageContext | undefined): bigint {
  return storage === undefined
    ? 0n
    : BigInt(storage.outputCharsPerToken) * STORAGE_COST_PER_CHARACTER_NANO;
}

/** The one-off prompt input-storage cost (0 when the turn does not persist). */
function inputStorageNanoUsd(storage: SmartModelStorageContext | undefined): bigint {
  return storage === undefined ? 0n : BigInt(storage.inputChars) * STORAGE_COST_PER_CHARACTER_NANO;
}

/** The classifier's pass-through storage line (0 when the turn does not persist). */
function classifierStorageNanoUsd(
  classifier: SmartModelPoolCandidate,
  candidates: readonly SmartModelPoolCandidate[],
  storage: SmartModelStorageContext | undefined
): bigint {
  if (storage === undefined) return 0n;
  const items = classifierReserveLineItems(classifier, candidates, storage.outputCharsPerToken);
  /* v8 ignore next 2 -- a non-null pool guarantees a priceable classifier, and
     classifierLineItems always emits a storage item; `?? 0n` narrows only */
  return items?.find((item) => item.kind === 'storage')?.fixedNano ?? 0n;
}

/** One candidate's balance-independent cost basis: billable input cost at the
 * bounded prompt, per-token output cost (billable rate + storage), remaining ctx. */
/** A candidate's billable provider legs plus pass-through output storage —
 * enough to price {@link candidateCost} exactly as the admission estimator does. */
interface CandidateBasis {
  /** inputTokens × inputRate (billable) — the input leg of the provider subtotal. */
  readonly inputBaseNanoUsd: bigint;
  /** outputRate per token (billable) — the output leg of the provider subtotal. */
  readonly outputRateBaseNanoUsd: bigint;
  /** Output-storage cost per answer token (pass-through, never fee-bearing). */
  readonly outputStoragePerToken: bigint;
  readonly remaining: number;
}

function candidateBasis(
  candidate: SmartModelPoolCandidate,
  promptInputTokens: number | undefined,
  outputStoragePerToken: bigint
): CandidateBasis | undefined {
  const ctx = candidate.contextLength;
  const inputRateBase = candidate.pricing['inputPerToken'];
  const outputRateBase = candidate.pricing['outputPerToken'];
  /* v8 ignore next 7 -- callers resolve candidates from the priced pool, whose
     floor pricing already required a context length and both per-token rates;
     the guard narrows the optional fields for the compiler */
  if (
    ctx === undefined ||
    typeof inputRateBase !== 'bigint' ||
    typeof outputRateBase !== 'bigint'
  ) {
    return undefined;
  }
  // No stamped prompt (the defensive / budget-less build) assumes a negligible
  // input, so the whole context is answer room — the real paid path always
  // stamps `promptInputTokens`, and admission's own full-context input bound is
  // the fail-closed backstop for the unstamped case.
  const inputTokens = promptInputTokens === undefined ? 0 : Math.min(ctx, promptInputTokens);
  // The answer cap is bounded by BOTH the remaining context and the provider
  // completion ceiling (`maxOutputTokens`) — the model cannot emit past
  // either; an absent ceiling leaves the context bound alone (fallback).
  const contextHeadroom = ctx - inputTokens;
  const remaining =
    candidate.maxOutputTokens === undefined
      ? contextHeadroom
      : Math.min(contextHeadroom, candidate.maxOutputTokens);
  if (remaining < 1) return undefined;
  return {
    inputBaseNanoUsd: BigInt(inputTokens) * inputRateBase,
    outputRateBaseNanoUsd: outputRateBase,
    outputStoragePerToken,
    remaining,
  };
}

/**
 * A candidate's provider + output-storage cost for `cap` answer tokens, priced
 * EXACTLY as the admission estimator (`estimateRunCeilingNanoUsd`): a pure sum
 * of the billable provider subtotal (input + output legs) plus pass-through
 * output storage. Sharing this identity is what makes the per-candidate reserve
 * equal the estimator's hold, so the affordable subset can never be refused at
 * admission (the free-tier keystone) and client == server.
 */
function candidateCost(basis: CandidateBasis, cap: number): bigint {
  return (
    basis.inputBaseNanoUsd +
    BigInt(cap) * basis.outputRateBaseNanoUsd +
    BigInt(cap) * basis.outputStoragePerToken
  );
}

/** The largest cap in `[0, remaining]` whose {@link candidateCost} fits the
 * affordable budget — a binary search, since the cost is monotonic in cap. */
function candidateCapTokens(basis: CandidateBasis, affordableBudget: bigint): number {
  if (candidateCost(basis, 0) > affordableBudget) return 0;
  if (candidateCost(basis, basis.remaining) <= affordableBudget) return basis.remaining;
  let lo = 0;
  let hi = basis.remaining;
  while (lo < hi) {
    const mid = lo + Math.ceil((hi - lo) / 2);
    if (candidateCost(basis, mid) <= affordableBudget) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
