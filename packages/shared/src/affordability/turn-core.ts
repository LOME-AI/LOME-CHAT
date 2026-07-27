/**
 * The pure core of the one producer: one `(funding, basis)` pair in, one
 * {@link OptionSet} plus the priced line items out. `getTurnOptions` runs it
 * twice — once against `effectiveBalance` with the empty basis, once against
 * `spendable` with the composed basis — and nothing else may run it, which is
 * why this file is not on any barrel.
 *
 * What it does, in the specification's own terms (`docs/BILLING.md`):
 *
 * 1. An **arrangement** is a set of siblings that would answer together. A turn
 *    with pinned models alone has one; a smart slot adds one per candidate, and
 *    every non-pinned catalog model gets one too — that is how the picker's rows
 *    answer "could I run this beside what I have selected".
 * 2. Each arrangement solves ONE shared token count against the summed variable
 *    rates (§Sharing one budget across siblings), then clamps each sibling by its
 *    OWN `providerCap` and `contextHeadroom`. A small-context sibling therefore
 *    never caps a large-context one.
 * 3. The priced basis is `Σᵢ cost(mᵢ, ceiling(mᵢ))` plus the turn-level fixed
 *    terms — never `T × Σrates`, which §Multi-Model 2 forbids.
 * 4. The smart slot takes the `MAX` over candidate arrangements, never the `Σ`:
 *    exactly one candidate answers.
 * 5. **Four readings, ONE derivation.** What the classifier may pick (the
 *    candidate rows), what the user may pick (the turn-level menu), what the
 *    server admits (the send gate) and what money is reserved (the hold's `MAX`
 *    domain) are all queries over {@link reachableAt} — which arrangements the
 *    turn could become can run at a given effort. Each of those four is a
 *    decision, so a disagreement between any two of them is a defect rather than
 *    a cosmetic difference — and they cannot disagree, because there is nothing to
 *    disagree with.
 * 6. **Pricing and presentation still read different arrangements, deliberately.**
 *    An entry is graded on the arrangement it describes, whose membership no
 *    funding number can change. Collapsing that into the hold's arrangement makes
 *    a presented ceiling non-monotone in the funding, which breaks
 *    `admissible ⊆ affordable` — see {@link entriesFor}.
 *
 * Pure: no clock, no I/O, no randomness, and content-free — counts, rates and
 * identifiers only.
 */

import { classifierIsBought, dimensionSupportFor, resolveOption } from './dimensions/derive.js';
import { cheapestEffortOption, EFFORT_DIMENSION, EFFORT_OPTION_IDS } from './dimensions/effort.js';
import { classifierLineItems, classifierReserveChars } from './estimate/classifier-line-item.js';
import { estimateTokensForTier, outputCharsPerTokenForTier } from './estimate/pre-adapters.js';
import { evaluateManifest } from './estimate/reducers.js';
import { webSearchLineItem } from './estimate/search-reservation.js';
import { combinedRateNanoUsd, exceedsTrialBudget } from './premium.js';
import {
  budgetBuysTokens,
  callCostBasisForTier,
  ceilingTokens,
  contextHeadroomTokens,
  costNanoUsd,
  feasible,
  fixedCostsNanoUsd,
  inputStorageNanoUsd,
  inputTokensOf,
  outlierModelIds,
  requiredCeilingTokens,
  siblingLineItems,
  variableRateNanoUsd,
} from './turn-arithmetic.js';
import { promptCharsOf, refusalPrecedence } from './turn-types.js';
import type { CallCostBasis, CostContext } from './turn-arithmetic.js';
import type { DimensionOption, OptionId } from './dimensions/index.js';
import type { NanoLineItem } from './estimate/types.js';
import type { PriceableModel } from './priceable-model.js';
import type {
  Availability,
  CandidateModelEntry,
  DimensionAvailability,
  ModelEntry,
  OptionAvailability,
  OptionSet,
  PinnedModelEntry,
  PromptBasis,
  RefusalCode,
  Selection,
} from './turn-types.js';
import type { UserTier } from './tiers.js';

export interface CoreInput {
  /** `effectiveBalance` for the affordable pass, `spendable` for the admissible one. */
  readonly fundingNanoUsd: bigint;
  readonly basis: PromptBasis;
  readonly selection: Selection;
  /** The priceable catalog pool — every model with a usable rate and cap. */
  readonly catalog: readonly PriceableModel[];
  readonly tier: UserTier;
}

export interface CoreResult {
  readonly optionSet: OptionSet;
  /** The priced total of the arrangement a hold would be taken for. */
  readonly totalNanoUsd: bigint | undefined;
  /**
   * The line items that total folds. Not part of {@link OptionSet}: §Data
   * Structures does not carry a manifest to a surface, and the storage-drop and
   * reservation-amount properties need something to assert against, so the
   * manifest travels on the core's result where tests can pin it.
   */
  readonly lineItems: readonly NanoLineItem[];
}

/** What the turn's effort selection resolves to on one model. */
interface EffortGate {
  /**
   * The option eligibility is graded on: the resolved pin, or `e_min(m)`.
   * `undefined` when the dimension does not apply to this model at all.
   */
  readonly option: OptionId | undefined;
  /** False when a pinned option has nothing at or below it on this model. */
  readonly resolvable: boolean;
}

/** Everything an arrangement prices against that does not vary by sibling. */
interface PricingContext {
  readonly fundingNanoUsd: bigint;
  readonly tier: UserTier;
  readonly persists: boolean;
  readonly inputTokens: number;
  readonly promptChars: number;
  readonly inputStorageNanoUsd: bigint;
  readonly classifierReserveNanoUsd: bigint;
  readonly webSearch: boolean;
  readonly effortPin: OptionId | undefined;
}

/**
 * One set of siblings, priced. It carries no verdict: whether it can run is a
 * question about an EFFORT as well as an arrangement, and the answer has one
 * home ({@link arrangementBlock}) rather than a cached field beside it.
 */
interface Arrangement {
  readonly siblings: readonly PriceableModel[];
  /** The shared token count `T`; `budgetBuys(m)` when there is one sibling. */
  readonly sharedTokens: number;
  readonly totalNanoUsd: bigint;
  readonly lineItems: readonly NanoLineItem[];
}

/**
 * `ceiling(m)` inside one arrangement: the arrangement contributes the shared
 * token count, the model its own physical bounds. Derived on demand rather than
 * carried in a per-arrangement map, so there is no lookup that can miss.
 */
function ceilingIn(
  arrangement: Pick<Arrangement, 'sharedTokens'>,
  model: PriceableModel,
  context: PricingContext
): number {
  return ceilingTokens(model, {
    contextHeadroomTokens: contextHeadroomTokens(model, context.inputTokens),
    sharedTokens: arrangement.sharedTokens,
  });
}

/**
 * A turn that cannot start still renders: the entries and the turn-level option
 * lists ride the unsendable arm too, because the payer who cannot send is the
 * one whose greying needs explaining. Only `runnable` is withheld, and only a
 * priced arrangement can produce a hold.
 */
function refused(
  reason: RefusalCode,
  entries: readonly ModelEntry[],
  turnDimensions: readonly DimensionAvailability[]
): CoreResult {
  return {
    optionSet: { sendable: false, refusal: reason, all: entries, turnDimensions },
    totalNanoUsd: undefined,
    lineItems: [],
  };
}

/**
 * The classifier engine: the cheapest priceable model, ordered on its combined
 * per-token rate with an identifier tiebreak.
 *
 * The order is deliberately BASIS-INDEPENDENT. A prompt-weighted order (the
 * candidate order of §Smart Model 1) could pick a different engine for the two
 * passes, and a cheaper engine on the `spendable` pass would let the admissible
 * ceiling exceed its affordable counterpart — breaking `admissible ⊆
 * affordable`. Whoever moves this onto `maxCallCost` must keep the engine
 * choice basis-independent or re-derive that invariant.
 */
function classifierEngine(catalog: readonly PriceableModel[]): PriceableModel | undefined {
  let cheapest: PriceableModel | undefined;
  for (const model of catalog) {
    if (cheapest === undefined) {
      cheapest = model;
      continue;
    }
    const rate = combinedRateNanoUsd(model);
    const best = combinedRateNanoUsd(cheapest);
    if (rate < best || (rate === best && model.modelId < cheapest.modelId)) cheapest = model;
  }
  return cheapest;
}

/**
 * The classifier's worst-case reserve, PROVIDER LEG ONLY. The classifier's
 * prompt and output are mid-flow values that never rest, so no storage is
 * reserved or charged for them on any tier (§Cost, §Reasoning Effort 7) — the
 * `kind === 'provider'` filter below is the mechanism that drops it, and nothing
 * else.
 */
function classifierReserveNanoUsd(catalog: readonly PriceableModel[], tier: UserTier): bigint {
  const engine = classifierEngine(catalog);
  /* v8 ignore next -- unreachable: a classifier is only bought when some model
     contributes an open dimension, so the pool this engine comes from is
     non-empty by the time anything asks for a reserve */
  if (engine === undefined) return 0n;
  const reserveChars = classifierReserveChars(catalog.map((model) => ({ id: model.modelId })));
  const items = classifierLineItems(
    {
      pricing: {
        inputPerToken: BigInt(engine.inputRateNanoUsd),
        outputPerToken: BigInt(engine.outputRateNanoUsd),
      },
      // The classifier reserve is tier-independent on its input leg and always
      // uses the conservative ratio, matching the admission-side derivation.
      inputTokens: BigInt(estimateTokensForTier('trial', reserveChars)),
      inputChars: reserveChars,
    },
    outputCharsPerTokenForTier(tier)
  );
  /* v8 ignore next -- a PriceableModel always carries both per-token rates and
     the counts above are derived, so the fail-closed channel cannot open here */
  if (!items.ok) return 0n;
  const providerItems = items.value.filter((item) => item.kind === 'provider');
  // The whole reserve is fixed — nothing about it scales with the turn's output —
  // so folding at zero output tokens through the canonical reducer yields it.
  return evaluateManifest({ items: providerItems }, 0n, { scope: 'all-in' });
}

/**
 * How the turn's effort selection lands on one model.
 *
 * A model that offers no rung — one that cannot reason at all — runs the turn
 * with no reasoning wire and reserves nothing, whether the turn pinned a level or
 * left it open. A mandatory-reasoning model with a single native word is NOT that
 * case: it offers that one rung, and grading it here on the rung's real budget is
 * what keeps eligibility on a reachable corner (§Predicates).
 *
 * An empty ladder does NOT veto the turn: the effort menu is the union of the
 * selection's offered rungs (§Reasoning Effort 4), so refusing a rung the same
 * call presents as available would enable a level the server rejects, which
 * §Reasoning Effort 3 forbids outright. Per-model resolution onto an empty ladder
 * is the declared mapping of §Reasoning Effort 10(a), not a substitution of the
 * turn's choice.
 */
function effortGate(model: PriceableModel, pin: OptionId | undefined): EffortGate {
  const support = dimensionSupportFor(EFFORT_DIMENSION, model);
  if (support.options.length === 0) return { option: undefined, resolvable: true };
  if (pin === undefined) return { option: cheapestEffortOption(model), resolvable: true };
  const resolved = resolveOption(EFFORT_DIMENSION, support, pin);
  // Resolution is total over the DECLARED domain — the off rung is offered
  // whenever reasoning exists and is not mandatory, and a mandatory ladder
  // resolves upward to its lowest rung — so an unresolvable pin means the id is
  // outside the domain entirely. That fails closed rather than dropping a
  // parameter the caller asked for.
  return { option: resolved, resolvable: resolved !== undefined };
}

/**
 * What one sibling prices against. `inputChars` lands on the FIRST sibling only:
 * `inputStorage` is counted once per turn and attributed to the first charge,
 * mirroring the settlement side (§Multi-Model 1).
 */
function costContextFor(context: PricingContext, isFirst: boolean): CostContext {
  return {
    inputTokens: context.inputTokens,
    inputChars: isFirst ? context.promptChars : 0,
    tier: context.tier,
    persists: context.persists,
  };
}

function priceArrangement(
  siblings: readonly PriceableModel[],
  context: PricingContext
): Arrangement {
  // The line-item builder is the single home of the web-search amount: the solve
  // reads the item's own figure rather than repeating its multiplication, so the
  // term the ceiling is solved against and the term a surface renders cannot
  // drift apart.
  const searchItem = context.webSearch ? webSearchLineItem(siblings.length) : undefined;
  const additiveNanoUsd = searchItem?.fixedNano ?? 0n;
  const solveFixed = fixedCostsNanoUsd({
    siblings,
    inputTokens: context.inputTokens,
    inputStorageNanoUsd: context.inputStorageNanoUsd,
    classifierReserveNanoUsd: context.classifierReserveNanoUsd,
    additiveNanoUsd,
  });
  let summedVariableRate = 0n;
  for (const sibling of siblings) {
    summedVariableRate += variableRateNanoUsd(sibling, context.tier, context.persists);
  }
  const sharedTokens = budgetBuysTokens(context.fundingNanoUsd, solveFixed, summedVariableRate);

  const lineItems: NanoLineItem[] = [];
  if (context.classifierReserveNanoUsd > 0n) {
    lineItems.push({
      label: 'classifier-tokens',
      fixedNano: context.classifierReserveNanoUsd,
      kind: 'provider',
    });
  }
  if (searchItem !== undefined) lineItems.push(searchItem);

  // The turn-level fixed terms above, plus each sibling's own cost at its own
  // ceiling — Σᵢ cost(mᵢ, ceiling(mᵢ)), the priced basis §Multi-Model 2 requires.
  let totalNanoUsd = context.classifierReserveNanoUsd + additiveNanoUsd;
  for (const [index, sibling] of siblings.entries()) {
    const ceiling = ceilingIn({ sharedTokens }, sibling, context);
    const costContext = costContextFor(context, index === 0);
    lineItems.push(...siblingLineItems(sibling, costContext));
    totalNanoUsd += costNanoUsd(sibling, ceiling, costContext);
  }

  return { siblings, sharedTokens, totalNanoUsd, lineItems };
}

/**
 * Which of the ceiling's three bounds refused a token requirement, in the
 * precedence §Notices & Refusals 4 fixes: money first, then the prompt, then the
 * model's own output cap. One ladder, read by both the entry verdict and every
 * option's verdict, so a surface cannot explain the same condition two ways.
 */
function boundReason(
  model: PriceableModel,
  arrangement: Arrangement,
  context: PricingContext,
  requiredTokens: number
): RefusalCode {
  if (arrangement.sharedTokens < requiredTokens) return 'insufficient_funds';
  if (contextHeadroomTokens(model, context.inputTokens) < requiredTokens) return 'prompt_too_long';
  return 'model_output_cap_too_low';
}

/**
 * Why one sibling cannot answer at `effort` inside this arrangement — `undefined`
 * when it can. THE leaf predicate: every reading this file publishes is built
 * from this one function, so "can this run" has a single definition wherever it
 * is asked. An effort the model cannot resolve refuses outright; otherwise the
 * minimum-answer floor is tested against the ceiling and {@link boundReason}
 * names the bound.
 *
 * `effort` is the selection to grade under — the turn's own pin, or a rung the
 * menu is asking about. `undefined` means open, which grades on `e_min(m)`: that
 * is `eligible(m)`, and `feasible(m, e)` on a resolved pin. One predicate either
 * way.
 *
 * The trial per-message cap is tested FIRST, in the precedence
 * {@link REFUSAL_CODES} declares: it is a tier fact, not a funding one, so no
 * balance and no shorter answer clears it and a money reason would name an action
 * that cannot help (§Notices & Refusals 3, §Trial Usage).
 */
function siblingBlock(
  model: PriceableModel,
  arrangement: Arrangement,
  context: PricingContext,
  effort: OptionId | undefined
): RefusalCode | undefined {
  if (context.tier === 'trial' && exceedsTrialBudget(model, context.promptChars)) {
    return 'trial_message_cap_exceeded';
  }
  const gate = effortGate(model, effort);
  if (!gate.resolvable) return 'option_not_offered';
  const ceiling = ceilingIn(arrangement, model, context);
  if (feasible(model, gate.option, ceiling)) return undefined;
  return boundReason(model, arrangement, context, requiredCeilingTokens(model, gate.option));
}

/**
 * Why this arrangement cannot run at `effort` — the conjunction over its
 * siblings, reduced to one reason in the precedence §Notices & Refusals 4 fixes.
 *
 * The conjunction is what §Story 1.2 asks for — "money for all three siblings …
 * and `B + MINIMUM_OUTPUT_TOKENS` inside every sibling's ceiling" — and what
 * makes §Story 1.3's pinned siblings a hard gate: they are not chooseable, so
 * they cap the whole turn. A candidate whose arrangement starves a pinned sibling
 * is therefore not a candidate, which is also the money half — the hold's `MAX`
 * ranges over exactly the arrangements this returns `undefined` for, so a
 * presented arrangement the `MAX` never priced is unrepresentable rather than
 * merely avoided (§Affordability: "the one place where using the wrong set is a
 * money defect").
 */
function arrangementBlock(
  arrangement: Arrangement,
  context: PricingContext,
  effort: OptionId | undefined
): RefusalCode | undefined {
  const [first, ...rest] = arrangement.siblings.flatMap((sibling) => {
    const block = siblingBlock(sibling, arrangement, context, effort);
    return block === undefined ? [] : [block];
  });
  return first === undefined ? undefined : refusalPrecedence([first, ...rest]);
}

/** What the turn can become at one effort, and why the rest of it cannot. */
interface Reachable {
  /** Every presented arrangement that can run at this effort. */
  readonly running: readonly Arrangement[];
  /** One reason per arrangement that cannot. */
  readonly blocks: readonly RefusalCode[];
}

/**
 * THE derivation, and the whole point of its existing: the send gate is `running`
 * being non-empty, the hold is the `MAX` over `running`, the turn-level menu asks
 * the same question once per rung, and a row's verdict is
 * {@link arrangementBlock} — this function's own per-arrangement step — over the
 * arrangement that row describes.
 *
 * Each of those is a decision, so a disagreement between two of them is a money or
 * menu defect rather than a cosmetic difference. Deriving any of them separately is
 * what makes these silently possible: a hold taken over a set the classifier was
 * not presented, a menu enabling a rung the send gate refuses, a menu greying a
 * rung it would accept, a candidate ceiling above what its arrangement honours.
 * None of them is expressible against one derivation, which is why there is one.
 */
function reachableAt(
  presented: readonly Arrangement[],
  context: PricingContext,
  effort: OptionId | undefined
): Reachable {
  const running: Arrangement[] = [];
  const blocks: RefusalCode[] = [];
  for (const arrangement of presented) {
    const block = arrangementBlock(arrangement, context, effort);
    if (block === undefined) running.push(arrangement);
    else blocks.push(block);
  }
  return { running, blocks };
}

/**
 * What one row is graded by, at any effort. A row's own verdict is this at the
 * turn's effort selection and each of its rungs is this at that rung, so the two
 * cannot disagree: they are one function at different arguments.
 *
 * Only a candidate row needs one, because only a candidate row publishes rungs.
 */
type RowGrader = (effort: OptionId | undefined) => RefusalCode | undefined;

function availabilityOf(block: RefusalCode | undefined): Availability {
  return block === undefined ? { available: true } : { available: false, reason: block };
}

/**
 * One model's dimension lists. A dimension the model offers nothing on is absent
 * rather than present-and-empty, which is what keeps `options` a `NonEmpty`; the
 * model dimension has no entry here because its options ARE the model entries.
 *
 * A rung is graded on its own merits rather than inheriting an unavailable row's
 * reason: a row the turn cannot run at the effort SELECTED can still name the rung
 * that would make it runnable, and greying that rung hides the way out.
 */
function dimensionsFor(model: PriceableModel, grade: RowGrader): readonly DimensionAvailability[] {
  const support = dimensionSupportFor(EFFORT_DIMENSION, model);
  const [first, ...rest] = support.options.map(
    (option): OptionAvailability => ({
      ...option,
      availability: availabilityOf(grade(option.optionId)),
    })
  );
  if (first === undefined) return [];
  return [{ dimensionId: 'effort', options: [first, ...rest] }];
}

/**
 * A pinned sibling's row: graded on its OWN fit ({@link siblingBlock}), because
 * the sibling is already chosen and the row's only job is to name which sibling is
 * the problem (§Story 1.3). That verdict is finer than the arrangement's, so it may
 * disagree with the turn's — which is exactly why the shape publishes no
 * per-option list for anything to decide from.
 */
function pinnedEntryFor(
  model: PriceableModel,
  arrangement: Arrangement,
  context: PricingContext
): PinnedModelEntry {
  return {
    kind: 'pinned',
    modelId: model.modelId,
    availability: availabilityOf(siblingBlock(model, arrangement, context, context.effortPin)),
    ceilingTokens: ceilingIn(arrangement, model, context),
  };
}

/**
 * A candidate's row: graded on the whole arrangement it would create
 * ({@link arrangementBlock}), because it is what the classifier may pick and its
 * rungs are the per-candidate ceiling a classifier answer clamps onto — §Story
 * 2.2's "capped by the tightest pinned sibling".
 *
 * The row's verdict and each of its rungs are one grader at different arguments,
 * so a rung standing above the row's own verdict at that rung is unrepresentable.
 */
function candidateEntryFor(
  model: PriceableModel,
  arrangement: Arrangement,
  context: PricingContext
): CandidateModelEntry {
  const grade: RowGrader = (effort) => arrangementBlock(arrangement, context, effort);
  return {
    kind: 'candidate',
    modelId: model.modelId,
    availability: availabilityOf(grade(context.effortPin)),
    ceilingTokens: ceilingIn(arrangement, model, context),
    dimensions: dimensionsFor(model, grade),
  };
}

/**
 * Every rung any sibling of any presented arrangement offers, in the domain's own
 * ascending order — the menu's rows (§Reasoning Effort 4: "the union of all
 * selected models' offered levels").
 *
 * It reads the arrangements' MEMBERSHIP, which the selection fixes, so the rows
 * are funding-independent: a rung cannot appear and disappear as the balance
 * moves, and an unsendable turn still has rows to grey.
 */
function offeredRungs(presented: readonly Arrangement[]): readonly DimensionOption[] {
  const byOption = new Map<OptionId, DimensionOption>();
  for (const arrangement of presented) {
    for (const sibling of arrangement.siblings) {
      for (const option of dimensionSupportFor(EFFORT_DIMENSION, sibling).options) {
        byOption.set(option.optionId, option);
      }
    }
  }
  return EFFORT_OPTION_IDS.flatMap((optionId) => {
    const option = byOption.get(optionId);
    return option === undefined ? [] : [option];
  });
}

/**
 * The turn-level option list for the effort dimension: each rung graded by the
 * SAME query the send gate runs, asked once per rung.
 *
 * That composes the specification's two quantifiers correctly because they live in
 * one place — an AND over the pinned siblings, which are not chooseable and so cap
 * the whole turn (§Story 2.1), inside an OR over the arrangements a smart slot
 * could pick, since an effort is enabled iff at least one candidate can honour it
 * (§Story 2.8). Merging the ROWS instead inverted them: a pinned sibling's own
 * verdict got OR'd, which enabled rungs the send gate refuses, and an unavailable
 * row greyed every rung it offers, which hid the lower rung that would have sent.
 *
 * A greyed rung carries the reason the send gate itself would give, because both
 * reduce the same arrangement blocks through the same precedence.
 */
function turnDimensionsFor(
  presented: readonly Arrangement[],
  context: PricingContext
): readonly DimensionAvailability[] {
  const [first, ...rest] = offeredRungs(presented).map((option): OptionAvailability => {
    const reachable = reachableAt(presented, context, option.optionId);
    return {
      ...option,
      availability:
        reachable.running.length > 0
          ? { available: true }
          : { available: false, reason: refusalPrecedence(reachable.blocks) },
    };
  });
  if (first === undefined) return [];
  return [{ dimensionId: 'effort', options: [first, ...rest] }];
}

/** Whether an open dimension buys the turn's one classifier call. */
function classifierIsBoughtForTurn(
  effortContributors: readonly PriceableModel[],
  effortOpen: boolean,
  modelOpen: boolean,
  candidateCount: number
): boolean {
  if (modelOpen && candidateCount >= 2) return true;
  if (!effortOpen) return false;
  return effortContributors.some((model) =>
    classifierIsBought(EFFORT_DIMENSION, model, dimensionSupportFor(EFFORT_DIMENSION, model))
  );
}

/**
 * Who would answer: the pinned siblings, the ids nothing prices, and two readings
 * of the rest of the catalog.
 *
 * `candidatePool` is every non-pinned model and is what the PICKER renders — an
 * outlier is excluded from the product nowhere, so it keeps its row and stays one
 * deliberate click away. `classifierPool` is that pool minus `outlier(m)` and is
 * the CLASSIFIER-SELECTABLE set: the arrangements a smart slot could become, and
 * therefore the domain the hold's `MAX` ranges over (§Smart Model 3).
 */
interface SiblingPlan {
  readonly pinnedModels: readonly PriceableModel[];
  readonly unpriceableIds: readonly string[];
  readonly candidatePool: readonly PriceableModel[];
  readonly classifierPool: readonly PriceableModel[];
  /**
   * The candidate ids `outlier(m)` removed — `candidatePool` minus
   * `classifierPool`. A PINNED model is never in here however extreme it is:
   * pinning IS the explicit selection §Smart Model 3 keeps available.
   */
  readonly excludedIds: ReadonlySet<string>;
  readonly smartSlot: boolean;
}

function planSiblings(
  catalog: readonly PriceableModel[],
  selection: Selection,
  basis: CallCostBasis
): SiblingPlan {
  const byId = new Map(catalog.map((model) => [model.modelId, model]));
  const pinnedIds = selection.answerSources.models;
  const pinnedModels: PriceableModel[] = [];
  const unpriceableIds: string[] = [];
  for (const modelId of pinnedIds) {
    const model = byId.get(modelId);
    if (model === undefined) unpriceableIds.push(modelId);
    else pinnedModels.push(model);
  }
  // The median is taken over the whole priceable catalog pool, pinned models
  // included: it must be reproducible from the catalog and the prompt size, and a
  // selection-dependent median would make the exclusion set move as the user
  // pins siblings.
  const outliers = outlierModelIds(catalog, basis);
  const candidatePool = catalog.filter((model) => !pinnedIds.includes(model.modelId));
  const excluded = candidatePool.filter((model) => outliers.has(model.modelId));
  return {
    pinnedModels,
    unpriceableIds,
    candidatePool,
    classifierPool: candidatePool.filter((model) => !outliers.has(model.modelId)),
    excludedIds: new Set(excluded.map((model) => model.modelId)),
    smartSlot: selection.answerSources.smartSlot,
  };
}

/**
 * The prompt-and-tier half of a cost, with no funding term. Shared by the outlier
 * pool (which must stay balance-independent) and the arrangement pricing, so the
 * two cannot disagree about how wide the prompt leaves a model.
 */
function callCostBasisFor(input: CoreInput): CallCostBasis {
  // Trial turns are ephemeral, so nothing about them is stored and no storage
  // term appears anywhere in their pricing.
  const persists = input.tier !== 'trial';
  return callCostBasisForTier(inputTokensOf(input.basis, input.tier), input.tier, persists);
}

function pricingContextFor(input: CoreInput, plan: SiblingPlan): PricingContext {
  const { basis, tier, selection, catalog } = input;
  const { inputTokens, persists } = callCostBasisFor(input);
  const effortPin = selection.pinned.effort;
  // Pool SIZE decides whether the classifier is bought (§Reserve ⟺ classify), and
  // the pool it sizes is the classifier-selectable one — an excluded outlier is
  // not an option the classifier could be asked to choose between.
  const classifierBought = classifierIsBoughtForTurn(
    plan.smartSlot ? [...plan.pinnedModels, ...plan.classifierPool] : plan.pinnedModels,
    effortPin === undefined,
    plan.smartSlot,
    plan.classifierPool.length
  );
  return {
    fundingNanoUsd: input.fundingNanoUsd,
    tier,
    persists,
    inputTokens,
    promptChars: promptCharsOf(basis),
    inputStorageNanoUsd: inputStorageNanoUsd(basis, persists),
    classifierReserveNanoUsd: classifierBought ? classifierReserveNanoUsd(catalog, tier) : 0n,
    webSearch: selection.webSearch,
    effortPin,
  };
}

/** The costliest arrangement of a set — the `MAX` the hold is sized against. */
function worstOf(arrangements: readonly Arrangement[]): Arrangement | undefined {
  let worst: Arrangement | undefined;
  for (const arrangement of arrangements) {
    if (worst === undefined || arrangement.totalNanoUsd > worst.totalNanoUsd) worst = arrangement;
  }
  return worst;
}

/**
 * One entry per catalog model, plus one per selected id nothing prices.
 *
 * **Every entry is graded on an arrangement whose MEMBERSHIP is fixed by the
 * selection, never by the funding or the prompt.** A pinned sibling is read off
 * the pinned siblings alone; every other catalog model is read off `pinned +
 * itself`, which is how a picker row answers "could I run this beside what I
 * have selected". That is what makes a presented ceiling monotone in `(funding,
 * basis)`, and hence `admissible ⊆ affordable` true per model and per option:
 * for a fixed membership, `fixedCosts` and `Σ variableRate` do not depend on the
 * funding, so `budgetBuys` only grows as the funding grows and only shrinks as
 * the basis grows, and `contextHeadroom` only shrinks as the basis grows.
 *
 * A candidate's verdict is the CONJUNCTION of that arrangement's siblings
 * ({@link arrangementBlock}), which preserves the monotonicity: every conjunct is
 * monotone in `(funding, basis)` and the membership conjoined over is fixed, so an
 * AND of them is monotone too. It is also what makes the presented candidate set
 * and the set the hold's `MAX` is taken over the same set.
 *
 * Two rejected alternatives, both non-monotone. Reading a pinned sibling off the
 * arrangement the HOLD is sized for: with a smart slot present that is the worst
 * VIABLE candidate, and which candidate is worst — indeed which are viable at all
 * — is itself a function of the funding and the basis, so a richer pass can clear
 * a costlier candidate into viability, adopt it, and solve FEWER shared tokens
 * than a poorer pass. Taking the worst over ALL candidates instead: an unclamped
 * arrangement's total is `funding − ((funding − fixedCosts) mod Σrate)`, so which
 * arrangement is costliest turns on a modulus and flips arbitrarily as the
 * funding moves.
 *
 * The consequence, deliberately accepted: when the smart slot resolves to a
 * candidate, the shared token count shrinks, so a pinned sibling's delivered
 * ceiling can be below the one presented here. The per-candidate entries are
 * where that is visible — each carries the ceiling of the arrangement it would
 * create, which is exactly what §The four notions asks of the candidate set
 * ("which candidates may fill the smart slot, and up to what ceiling each") —
 * and the hold, unchanged, still covers the worst of them.
 */
function entriesFor(
  plan: SiblingPlan,
  pinnedArrangement: Arrangement | undefined,
  candidateArrangements: ReadonlyMap<string, Arrangement>,
  context: PricingContext
): readonly ModelEntry[] {
  const pinned =
    pinnedArrangement === undefined
      ? []
      : plan.pinnedModels.map((model) => pinnedEntryFor(model, pinnedArrangement, context));
  // A selected id nothing prices is a pinned row: the user named it, and the only
  // thing to say about it is that no arrangement contains it.
  const unpriceable = plan.unpriceableIds.map(
    (modelId): PinnedModelEntry => ({
      kind: 'pinned',
      modelId,
      availability: { available: false, reason: 'model_not_priceable' },
      ceilingTokens: 0,
    })
  );
  const candidates = plan.candidatePool.flatMap((candidate) => {
    const arrangement = candidateArrangements.get(candidate.modelId);
    /* v8 ignore next -- every candidate got an arrangement; this narrows the map
       lookup for the compiler and is not a reachable branch */
    if (arrangement === undefined) return [];
    return [candidateEntryFor(candidate, arrangement, context)];
  });
  return [...pinned, ...unpriceable, ...candidates];
}

/** Everything derived once per pass, threaded through the steps below. */
interface Evaluation {
  readonly plan: SiblingPlan;
  readonly context: PricingContext;
  /** {@link presentedArrangements} — what the turn could become. */
  readonly presented: readonly Arrangement[];
  /** Those arrangements judged at the turn's OWN effort selection. */
  readonly reachable: Reachable;
}

/**
 * Which arrangements the turn could BECOME. A smart slot always resolves to a
 * candidate, so with one present these are the candidates' arrangements and the
 * pinned siblings alone are not among them — that combination is only the frame a
 * pinned ROW is diagnosed in. Without a slot the selection IS the turn, so there
 * is exactly one.
 *
 * This is where the hold's `MAX`-over-candidates and its `Σ`-over-siblings shapes
 * come from, so the two live in one expression rather than in a branch beside
 * every reading.
 */
function presentedArrangements(
  plan: SiblingPlan,
  pinnedArrangement: Arrangement | undefined,
  candidateArrangements: ReadonlyMap<string, Arrangement>
): readonly Arrangement[] {
  if (plan.smartSlot) {
    return plan.classifierPool.flatMap((candidate) => {
      const arrangement = candidateArrangements.get(candidate.modelId);
      /* v8 ignore next -- the classifier pool is a subset of the candidate pool,
         so every member has an arrangement; this narrows the lookup only */
      return arrangement === undefined ? [] : [arrangement];
    });
  }
  return pinnedArrangement === undefined ? [] : [pinnedArrangement];
}

/**
 * The turn-level refusal, or `undefined` when the turn can start — the send gate,
 * as a query over {@link reachableAt}: the turn starts iff some arrangement it
 * could become can run at the effort selected, and the reason is those
 * arrangements' own blocks in the precedence §Notices & Refusals 4 fixes.
 *
 * A selected id nothing prices refuses whatever the arrangements say, because it
 * is not an arrangement at all — nothing priced it.
 */
function turnRefusal(evaluation: Evaluation): RefusalCode | undefined {
  const { plan, reachable } = evaluation;
  const unpriceable: readonly RefusalCode[] =
    plan.unpriceableIds.length > 0 ? ['model_not_priceable'] : [];
  if (reachable.running.length > 0) {
    const [onlyBlock] = unpriceable;
    return onlyBlock;
  }
  return refusalPrecedence([...reachable.blocks, ...unpriceable]);
}

export function evaluateTurn(input: CoreInput): CoreResult {
  const { selection, catalog } = input;
  // A per-unit modality prices nothing token-shaped, so there is no entry to
  // render and no ceiling to grade one on.
  if (selection.modality !== 'text') return refused('modality_not_priceable', [], []);

  const plan = planSiblings(catalog, selection, callCostBasisFor(input));
  const context = pricingContextFor(input, plan);
  const candidateArrangements = new Map<string, Arrangement>(
    plan.candidatePool.map((candidate) => [
      candidate.modelId,
      priceArrangement([...plan.pinnedModels, candidate], context),
    ])
  );
  const pinnedArrangement =
    plan.pinnedModels.length > 0 ? priceArrangement(plan.pinnedModels, context) : undefined;
  const presented = presentedArrangements(plan, pinnedArrangement, candidateArrangements);
  const evaluation: Evaluation = {
    plan,
    context,
    presented,
    reachable: reachableAt(presented, context, context.effortPin),
  };

  const entries = entriesFor(plan, pinnedArrangement, candidateArrangements, context);
  // `runnable` is the witness for what can run in THIS turn, so a high-cost
  // outlier is not among it: the smart slot cannot resolve to one, and the hold's
  // `MAX` is not taken over it. Its ROW stays in `all`, marked available, because
  // pinning it is a different selection and one the payer can still make
  // (§Smart Model 3). Membership of `all` is therefore wider than `runnable`,
  // which is what keeps `hold ≥ every runnable candidate's arrangement` true.
  const runnable = entries.filter(
    (entry) => entry.availability.available && !plan.excludedIds.has(entry.modelId)
  );
  const turnDimensions = turnDimensionsFor(presented, context);

  const refusal = turnRefusal(evaluation);
  if (refusal !== undefined) return refused(refusal, entries, turnDimensions);

  // The `MAX` over what the turn could become — one candidate answers, so it is
  // never a `Σ` across candidates — read only once the turn is known sendable,
  // which is what makes it total.
  const hold = worstOf(evaluation.reachable.running);
  const [firstRunnable, ...restRunnable] = runnable;
  /* v8 ignore next 3 -- unreachable: nothing blocked above means some presented
     arrangement runs, so its own row is available and its price is in hand */
  if (firstRunnable === undefined || hold === undefined) {
    return refused('model_not_priceable', entries, turnDimensions);
  }

  return {
    optionSet: {
      sendable: true,
      runnable: [firstRunnable, ...restRunnable],
      all: entries,
      turnDimensions,
    },
    totalNanoUsd: hold.totalNanoUsd,
    lineItems: hold.lineItems,
  };
}
