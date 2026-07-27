/**
 * The arithmetic vocabulary of `docs/BILLING.md` §Math & Terms, as one named
 * function per defined quantity. Every producer call site prices through these,
 * so a term can be changed in one place and nothing composes its own variant of
 * a formula the specification already fixes.
 *
 * Two conventions the whole file rests on:
 *
 * - **Storage rides `variableRate`.** A non-persisting turn therefore carries no
 *   storage term anywhere, because the one place a per-token storage rate is
 *   added is {@link variableRateNanoUsd} and it takes `persists`.
 * - **A rate is never multiplied into a hold.** `moneyPerToken` requirements
 *   from the dimension registry are units, not amounts; an amount only exists
 *   once a ceiling is in hand, which is what {@link costNanoUsd} takes.
 *
 * Pure: no clock, no I/O, no randomness, and no content — counts, rates and
 * identifiers only.
 */

import { MINIMUM_OUTPUT_TOKENS, OUTLIER_COST_MULTIPLE } from './constants.js';
import { dimensionSupportFor } from './dimensions/derive.js';
import { cheapestEffortOption, EFFORT_DIMENSION } from './dimensions/effort.js';
import {
  charsPerTokenForTier,
  outputCharsPerTokenForTier,
  outputStorageRatePerTokenNanoUsd,
} from './estimate/pre-adapters.js';
import { priceRequest } from './estimate/price-request.js';
import { evaluateManifest } from './estimate/reducers.js';
import { STORAGE_COST_PER_CHARACTER_NANO } from './estimate/storage-rate.js';
import { nanoPercentile } from './percentile.js';
import { promptCharsOf } from './turn-types.js';
import type { OptionId } from './dimensions/index.js';
import type { NanoLineItem } from './estimate/types.js';
import type { PriceableModel } from './priceable-model.js';
import type { PromptBasis } from './turn-types.js';
import type { UserTier } from './tiers.js';

/**
 * `storageRatePerToken(tier)` — output storage expressed per token, so one
 * formula prices a token's provider cost and its retention together. The ratio
 * is INVERTED from the input ratio (paid 2, every other tier 4) so the tier that
 * over-reserves input also over-reserves output storage.
 */
export function storageRatePerTokenNanoUsd(tier: UserTier): bigint {
  return outputStorageRatePerTokenNanoUsd(outputCharsPerTokenForTier(tier));
}

/**
 * `variableRate(m)` — the per-output-token cost of model `m`: its output rate
 * plus per-token storage when the turn persists, the bare output rate when it
 * does not.
 */
export function variableRateNanoUsd(
  model: PriceableModel,
  tier: UserTier,
  persists: boolean
): bigint {
  const storage = persists ? storageRatePerTokenNanoUsd(tier) : 0n;
  return BigInt(model.outputRateNanoUsd) + storage;
}

/**
 * `inputTokens` = `ceil(promptChars / charsPerToken(tier))`. Rounded up, against
 * the user: the input leg is not wire-capped, so an under-estimate here is the
 * one place a charge can exceed what was reserved for it.
 */
export function inputTokensOf(basis: PromptBasis, tier: UserTier): number {
  const chars = promptCharsOf(basis);
  if (chars === 0) return 0;
  return Math.ceil(chars / charsPerTokenForTier(tier));
}

/**
 * `inputStorage` = `promptChars × storageRatePerChar`, counted once per turn (not
 * once per sibling — {@link fixedCostsNanoUsd} takes it as a single term for
 * exactly that reason). Zero on a turn that does not persist.
 */
export function inputStorageNanoUsd(basis: PromptBasis, persists: boolean): bigint {
  if (!persists) return 0n;
  return BigInt(promptCharsOf(basis)) * STORAGE_COST_PER_CHARACTER_NANO;
}

export interface FixedCostsInput {
  /** Every sibling that will answer. Each is charged for the same input tokens. */
  readonly siblings: readonly PriceableModel[];
  readonly inputTokens: number;
  /** From {@link inputStorageNanoUsd} — one term, not one per sibling. */
  readonly inputStorageNanoUsd: bigint;
  /** Non-zero exactly when the turn will run a classifier (§Reserve ⟺ classify). */
  readonly classifierReserveNanoUsd: bigint;
  /**
   * Σ of every `additive` dimension's requirement. Today the web-search
   * reservation is the only additive term; when an additive dimension is
   * registered its requirement folds in here rather than growing a second term.
   */
  readonly additiveNanoUsd: bigint;
}

/**
 * `fixedCosts` — the turn's cost terms that do not scale with output tokens:
 * input tokens at each sibling's input rate, `inputStorage`, the classifier
 * reserve when a classifier runs, and any additive dimension's requirement.
 *
 * The per-sibling input leg belongs here rather than inside the shared-token
 * solve, which is what makes `budgetBuys(m) = floor((funding − fixedCosts) /
 * variableRate(m))` and the multi-sibling `T` solve the same equation with one
 * sibling and N.
 */
export function fixedCostsNanoUsd(input: FixedCostsInput): bigint {
  const inputTokens = BigInt(input.inputTokens);
  let total = input.inputStorageNanoUsd + input.classifierReserveNanoUsd + input.additiveNanoUsd;
  for (const sibling of input.siblings) {
    total += inputTokens * BigInt(sibling.inputRateNanoUsd);
  }
  return total;
}

export interface CostContext {
  readonly inputTokens: number;
  /**
   * The prompt characters whose storage this sibling carries. Non-zero on the
   * FIRST sibling of a turn only: prompt storage is one charge per turn, and
   * settlement anchors it onto the first persisted content (§Multi-Model 1).
   */
  readonly inputChars: number;
  readonly tier: UserTier;
  readonly persists: boolean;
}

/**
 * What a cost prices against, with the tier already resolved to its storage
 * ratio. {@link CostContext} is the tier-shaped view of the same thing: the tier
 * is a way of NAMING a ratio, and the two callers that hold one but not the other
 * must still price through one implementation.
 */
interface LineItemBasis {
  readonly inputTokens: number;
  readonly inputChars: number;
  /** `outputCharsPerToken(tier)` — the output-storage ratio. */
  readonly outputCharsPerToken: number;
  readonly persists: boolean;
}

/**
 * The ONE line-item construction in the turn producer, straight from the
 * canonical estimator: the priced total and the line items a surface can read are
 * two readings of this one list, never two derivations of the same amount.
 *
 * Storage items are dropped outright on a turn that does not persist — the
 * `kind !== 'storage'` filter is the mechanism, and nothing else.
 */
function lineItemsFor(model: PriceableModel, basis: LineItemBasis): readonly NanoLineItem[] {
  const priced = priceRequest({
    models: [
      {
        pricing: {
          inputPerToken: BigInt(model.inputRateNanoUsd),
          outputPerToken: BigInt(model.outputRateNanoUsd),
        },
      },
    ],
    inputTokens: BigInt(basis.inputTokens),
    inputChars: basis.persists ? basis.inputChars : 0,
    outputCharsPerToken: basis.outputCharsPerToken,
  });
  /* v8 ignore next -- a PriceableModel always prices: both rates are present and
     every count above is a validated non-negative integer */
  if (!priced.ok) return [];
  if (basis.persists) return priced.value.items;
  return priced.value.items.filter((item) => item.kind !== 'storage');
}

/** One sibling's billable manifest, at the payer's tier. */
export function siblingLineItems(
  model: PriceableModel,
  context: CostContext
): readonly NanoLineItem[] {
  return lineItemsFor(model, {
    inputTokens: context.inputTokens,
    inputChars: context.inputChars,
    outputCharsPerToken: outputCharsPerTokenForTier(context.tier),
    persists: context.persists,
  });
}

/**
 * `cost(m, tokens)` = `inputTokens × inputRate(m) + tokens × variableRate(m)`,
 * plus this sibling's share of prompt storage when it carries one. Storage rides
 * `variableRate`, so a non-persisting turn carries no storage term.
 *
 * It DELEGATES to {@link siblingLineItems} and the canonical reducer rather than
 * multiplying rates itself: pricing has one implementation, and a named term of
 * §Cost that merely agreed with it would be a second one (One Implementation,
 * Shared).
 */
export function costNanoUsd(
  model: PriceableModel,
  outputTokens: number,
  context: CostContext
): bigint {
  return evaluateManifest({ items: siblingLineItems(model, context) }, BigInt(outputTokens), {
    scope: 'all-in',
  });
}

/** `contextHeadroom(m)` = `contextLength(m) − inputTokens`, never negative. */
export function contextHeadroomTokens(model: PriceableModel, inputTokens: number): number {
  return Math.max(0, model.contextLength - inputTokens);
}

/**
 * `budgetBuys` — the largest token count whose cost fits the funding input:
 * `floor((funding − fixedCosts) / Σ variableRate)`. With one sibling the summed
 * rate is that sibling's own rate, which is §Math & Terms' `budgetBuys(m)`; with
 * N it is the shared token count `T` of §Sharing one budget across siblings.
 *
 * A summed rate of zero buys nothing rather than dividing by zero: a turn whose
 * output costs nothing has no money-derived ceiling, and the physical bounds
 * alone decide it.
 */
export function budgetBuysTokens(
  fundingNanoUsd: bigint,
  fixedCostsNano: bigint,
  summedVariableRateNanoUsd: bigint
): number {
  if (summedVariableRateNanoUsd <= 0n) return 0;
  const remaining = fundingNanoUsd - fixedCostsNano;
  if (remaining <= 0n) return 0;
  return Number(remaining / summedVariableRateNanoUsd);
}

export interface CeilingBounds {
  readonly contextHeadroomTokens: number;
  /** `budgetBuys(m)` for a solo turn, the shared `T` for siblings. */
  readonly sharedTokens: number;
}

/**
 * `ceiling(m)` = `min(providerCap(m), contextHeadroom(m), budgetBuys(m))` — what
 * the model can emit, what the prompt leaves free, and what the money can buy.
 * An absent provider cap falls back to the context length, per §Model bounds.
 *
 * No product-chosen answer length appears here: a payer who can pay for a
 * model's full output capability gets it.
 */
export function ceilingTokens(model: PriceableModel, bounds: CeilingBounds): number {
  const providerCap = model.providerCap ?? model.contextLength;
  return Math.max(0, Math.min(providerCap, bounds.contextHeadroomTokens, bounds.sharedTokens));
}

/**
 * The token count `maxCallCost(m)` prices: `min(providerCap(m),
 * contextHeadroom(m))` — what the model can physically emit and what the prompt
 * leaves free, with NO money bound. Dropping `budgetBuys` is what makes the
 * quantity balance-independent, and therefore what makes the outlier set
 * reproducible from the catalog and the prompt size alone.
 */
export function maxCallCostTokens(model: PriceableModel, inputTokens: number): number {
  const providerCap = model.providerCap ?? model.contextLength;
  return Math.max(0, Math.min(providerCap, contextHeadroomTokens(model, inputTokens)));
}

/**
 * What a call's cost depends on once the funding is out of it. Deliberately NOT a
 * full {@link CostContext} in two ways: `inputChars` has no place here, because
 * §Cost defines `cost(m, tokens)` without a prompt-storage term — that term is a
 * once-per-turn fixed cost, not part of what a call on `m` costs — and the
 * storage ratio arrives directly, so a caller holding one without a tier prices
 * through this same implementation instead of inverting the tier mapping.
 */
export type CallCostBasis = Omit<LineItemBasis, 'inputChars'>;

/** {@link CallCostBasis} for a payer at a tier. */
export function callCostBasisForTier(
  inputTokens: number,
  tier: UserTier,
  persists: boolean
): CallCostBasis {
  return { inputTokens, outputCharsPerToken: outputCharsPerTokenForTier(tier), persists };
}

/**
 * `maxCallCost(m)` = `cost(m, min(providerCap(m), contextHeadroom(m)))` — the
 * most a call on `m` could ever cost for this prompt. Money-only,
 * balance-independent and independent of the payer.
 *
 * It is the quantity the Smart Model pool is ORDERED by and the quantity the
 * outlier test measures, and those are the same number for one reason: the hold
 * is a `MAX` over the pool, so the most a call could cost is precisely what a
 * candidate's presence imposes on every other candidate (§Smart Model 1, 3).
 */
export function maxCallCostNanoUsd(model: PriceableModel, basis: CallCostBasis): bigint {
  return evaluateManifest(
    { items: lineItemsFor(model, { ...basis, inputChars: 0 }) },
    BigInt(maxCallCostTokens(model, basis.inputTokens)),
    { scope: 'all-in' }
  );
}

/**
 * The priceable catalog pool of §Predicates: every model with a usable rate and
 * a usable cap FOR THIS PROMPT. A model the prompt leaves no room for has no
 * usable cap, so it leaves the pool rather than ranking at zero and dragging the
 * median down. A `PriceableModel` carries both rates by construction, so the cap
 * is the only test left to make.
 */
function priceablePool(
  pool: readonly PriceableModel[],
  basis: CallCostBasis
): readonly PriceableModel[] {
  return pool.filter((model) => maxCallCostTokens(model, basis.inputTokens) > 0);
}

/** The middle of the sample. Named so the percentile call reads as the median. */
const MEDIAN_PERCENTILE = 0.5;

/**
 * `median(maxCallCost)` over the priceable catalog pool — NOT over the eligible
 * pool. Taking it over the eligible set would make it balance-dependent: a
 * low-balance payer would compute a different median, a different exclusion set,
 * and a pool that is no longer reproducible from the catalog (§Smart Model 3).
 * `undefined` when nothing in the pool prices.
 */
export function medianMaxCallCostNanoUsd(
  pool: readonly PriceableModel[],
  basis: CallCostBasis
): bigint | undefined {
  return nanoPercentile(
    priceablePool(pool, basis).map((model) => maxCallCostNanoUsd(model, basis)),
    MEDIAN_PERCENTILE
  );
}

/**
 * `outlier(m)` — the ids whose `maxCallCost` exceeds `OUTLIER_COST_MULTIPLE ×
 * median(maxCallCost)`. STRICTLY greater, so a model sitting exactly at the
 * multiple stays in.
 *
 * These ids leave the classifier-selectable set only. Nothing here removes a
 * model from the product: an excluded model stays explicitly selectable, and the
 * exclusion exists because the hold is a `MAX` over the pool — an extreme
 * candidate is not a free option, it is an option that taxes the others
 * (§Smart Model 3).
 */
export function outlierModelIds(
  pool: readonly PriceableModel[],
  basis: CallCostBasis
): ReadonlySet<string> {
  const median = medianMaxCallCostNanoUsd(pool, basis);
  if (median === undefined) return new Set();
  const threshold = OUTLIER_COST_MULTIPLE * median;
  return new Set(
    priceablePool(pool, basis)
      .filter((model) => maxCallCostNanoUsd(model, basis) > threshold)
      .map((model) => model.modelId)
  );
}

/** Whether the model offers any rung of the effort dimension at all. */
function offersEffort(model: PriceableModel): boolean {
  return dimensionSupportFor(EFFORT_DIMENSION, model).options.length > 0;
}

/**
 * `B(m, e)` — the reasoning budget option `e` reserves out of `ceiling(m)`, read
 * from the dimension registry so the ladder has one home. A model that offers no
 * rung reserves nothing; on a model that does, an unoffered rung is a caller
 * defect and the registry throws rather than reporting a phantom zero.
 */
export function reasoningBudgetTokens(model: PriceableModel, option: OptionId): number {
  if (!offersEffort(model)) return 0;
  return Number(EFFORT_DIMENSION.requirement(model, option));
}

/**
 * `B(m, e) + MINIMUM_OUTPUT_TOKENS` — the smallest ceiling that lets `m` run
 * option `e` and still emit a minimum viable answer. The single home of the
 * quantity: {@link feasible} tests it, and a caller naming which of the
 * ceiling's three bounds refused reads the same number rather than re-adding it.
 *
 * An absent option means no rung applies — a model that offers nothing on the
 * dimension reserves nothing for it.
 */
export function requiredCeilingTokens(model: PriceableModel, option?: OptionId): number {
  const reserved = option === undefined ? 0 : reasoningBudgetTokens(model, option);
  return reserved + MINIMUM_OUTPUT_TOKENS;
}

/**
 * `feasible(m, e)` = `B(m, e) + MINIMUM_OUTPUT_TOKENS ≤ ceiling(m)` — the effort
 * leaves room for a minimum answer. THE predicate: a menu enables a level iff
 * this returns true, which is what makes "a menu can never enable a level the
 * server refuses" structural rather than coordinated (§Reasoning Effort 3).
 */
export function feasible(
  model: PriceableModel,
  option: OptionId | undefined,
  ceiling: number
): boolean {
  return requiredCeilingTokens(model, option) <= ceiling;
}

/**
 * `eligible(m)` = `ceiling(m) ≥ B(m, e_min(m)) + MINIMUM_OUTPUT_TOKENS`. Graded
 * on the resolved cheapest corner, never on an unreachable zero: a
 * mandatory-reasoning model whose ceiling fits a minimum answer but not its
 * lowest rung beside it is not eligible. `e_min(m)` comes from the dimension
 * registry rather than being re-derived here, and a model with no rung at all
 * yields `undefined` — the minimum answer alone.
 */
export function eligible(model: PriceableModel, ceiling: number): boolean {
  return feasible(model, cheapestEffortOption(model), ceiling);
}
