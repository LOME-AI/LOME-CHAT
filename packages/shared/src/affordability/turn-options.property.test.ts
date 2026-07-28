/**
 * `admissible ⊆ affordable`, per model and per option, always
 * (`docs/BILLING.md` §Invariants, as equations).
 *
 * The property has to hold across BOTH inputs that differ between the sets, so
 * the generator moves both: the held fraction of the balance (which shrinks
 * `spendable` below `effectiveBalance`) and the prompt basis (which is never
 * smaller than the empty one the affordable pass uses). It is what guarantees
 * the send gate can never permit something the picker greyed.
 *
 * The same sweep carries the marked-never-filtered property, because both are
 * statements about every entry of every generated turn: an entry or an option
 * that vanished would satisfy a subset check trivially, so the two are pinned
 * over one generator rather than two.
 */

import { describe, expect, it } from 'vitest';

import { intBetween, mulberry32, pick } from '../__tests__/seeded-prng.js';
import { dimensionSupportFor } from './dimensions/derive.js';
import { EFFORT_DIMENSION, EFFORT_OPTION_IDS } from './dimensions/effort.js';
import { modelId } from './model-id.js';
import { nanoUSD } from './nano-usd.js';
import { getTurnOptions } from './turn-options.js';
import type { Rng } from '../__tests__/seeded-prng.js';
import type { PriceableModel } from './priceable-model.js';
import type {
  CandidateModelEntry,
  ModelEntry,
  OptionSet,
  PromptBasis,
  Selection,
  TurnOptions,
} from './turn-types.js';

/** A fixed instant: premium classification takes its clock as an argument. */
const NOW_MS = 1_800_000_000_000;

const CATALOG: readonly PriceableModel[] = [
  {
    modelId: modelId('vendor/a-cheap'),
    inputRateNanoUsd: nanoUSD(60n),
    outputRateNanoUsd: nanoUSD(150n),
    contextLength: 200_000,
    providerCap: 64_000,
    releasedAtMs: 0,
    reasoning: { supportedEfforts: ['high', 'medium', 'low'] },
  },
  {
    modelId: modelId('vendor/b-mid'),
    inputRateNanoUsd: nanoUSD(1200n),
    outputRateNanoUsd: nanoUSD(3600n),
    contextLength: 64_000,
    providerCap: 16_000,
    releasedAtMs: 0,
    reasoning: { supportedEfforts: null },
  },
  {
    modelId: modelId('vendor/c-mandatory'),
    inputRateNanoUsd: nanoUSD(2500n),
    outputRateNanoUsd: nanoUSD(9000n),
    contextLength: 32_000,
    providerCap: 12_000,
    releasedAtMs: 0,
    reasoning: { supportedEfforts: ['high', 'medium', 'low'], mandatory: true },
  },
  {
    modelId: modelId('vendor/d-plateau'),
    inputRateNanoUsd: nanoUSD(400n),
    outputRateNanoUsd: nanoUSD(900n),
    contextLength: 3000,
    providerCap: 1200,
    releasedAtMs: 0,
    reasoning: { supportedEfforts: ['high', 'medium', 'low'] },
  },
  {
    modelId: modelId('vendor/e-plain'),
    inputRateNanoUsd: nanoUSD(800n),
    outputRateNanoUsd: nanoUSD(1600n),
    contextLength: 128_000,
    providerCap: 8000,
    releasedAtMs: 0,
    reasoning: undefined,
  },
];

const MODEL_IDS = CATALOG.map((model) => model.modelId);
const EFFORT_PINS = [undefined, 'off', 'lite', 'low', 'medium', 'high', 'max'] as const;
const TIERS = ['paid', 'free', 'trial', 'guest'] as const;

function basisOf(rng: Rng): PromptBasis {
  return {
    systemChars: intBetween(rng, 0, 4000),
    instructionChars: intBetween(rng, 0, 2000),
    historyChars: intBetween(rng, 0, 120_000),
    inputChars: intBetween(rng, 0, 4000),
    attachmentBytes: 0,
  };
}

function selectionOf(rng: Rng): Selection {
  const count = intBetween(rng, 0, 3);
  const shuffled = MODEL_IDS.filter(() => rng() > 0.35).slice(0, count);
  // A smart slot BESIDE pinned siblings is the shape where a pinned entry could
  // be graded against an arrangement the slot's occupant helps choose, so it is
  // drawn deliberately and counted below. Left to chance it is rare, and a sweep
  // that misses it leaves the monotonicity of a pinned ceiling unconstrained.
  const smartSlot = shuffled.length === 0 ? true : rng() > 0.35;
  const pin = pick(rng, EFFORT_PINS);
  return {
    answerSources: smartSlot
      ? { models: shuffled, smartSlot: true }
      : {
          models: [shuffled[0] ?? MODEL_IDS[0] ?? modelId('vendor/none'), ...shuffled.slice(1)],
          smartSlot: false,
        },
    modality: 'text',
    pinned: pin === undefined ? {} : { effort: pin },
    webSearch: rng() > 0.7,
  };
}

/** Whether the draw carries a smart slot beside at least one pinned sibling. */
function isSmartSlotBesidePinned(selection: Selection): boolean {
  return selection.answerSources.smartSlot && selection.answerSources.models.length > 0;
}

/** The ids whose availability the smart slot's own candidate pool decides. */
function availableCandidateIds(set: OptionSet, selection: Selection): readonly string[] {
  const pinnedIds = selection.answerSources.models;
  return entriesOf(set)
    .filter((entry) => !pinnedIds.includes(entry.modelId) && entry.availability.available)
    .map((entry) => entry.modelId);
}

/**
 * Whether the two passes disagree about which candidates could fill the smart
 * slot. That disagreement is the observable face of candidate viability
 * flipping between the passes, which is the input that moves a
 * reference-arrangement choice — a sweep that never sees it cannot constrain
 * how a pinned entry is graded.
 */
function candidateSetsDiffer(pair: TurnOptions, selection: Selection): boolean {
  const affordable = availableCandidateIds(pair.affordable, selection).join(',');
  const admissible = availableCandidateIds(pair.admissible, selection).join(',');
  return affordable !== admissible;
}

function entriesOf(set: OptionSet): readonly ModelEntry[] {
  // Both arms carry every entry: a refused turn is still rendered, so the subset
  // and marked-never-filtered properties bind on it too.
  return set.all;
}

function availabilityOf(set: OptionSet, modelId: string): boolean {
  return entriesOf(set).some((entry) => entry.modelId === modelId && entry.availability.available);
}

/**
 * Whether one CANDIDATE row presents an option. A pinned row publishes no option
 * list — its own-fit verdicts are no decision's business — so the per-option half
 * of `admissible ⊆ affordable` binds on the candidate rows, and a pinned sibling
 * is constrained at row level by its availability and its ceiling instead.
 */
function optionAvailableIn(set: OptionSet, modelId: string, optionId: string): boolean {
  const entry = entriesOf(set).find((candidate) => candidate.modelId === modelId);
  if (entry?.kind !== 'candidate') return false;
  return entry.dimensions.some((dimension) =>
    dimension.options.some(
      (option) => option.optionId === optionId && option.availability.available
    )
  );
}

function ceilingOf(set: OptionSet, modelId: string): number | undefined {
  return entriesOf(set).find((entry) => entry.modelId === modelId)?.ceilingTokens;
}

/** Whether the TURN-level union enables a rung, rather than one model's row. */
function turnOptionAvailableIn(set: OptionSet, optionId: string): boolean {
  return set.turnDimensions.some((dimension) =>
    dimension.options.some(
      (option) => option.optionId === optionId && option.availability.available
    )
  );
}

/**
 * Every model, every rung of every model, every ceiling, and the turn-level
 * union. §Math & Terms states the ceiling half explicitly — "every ceiling in the
 * admissible set is therefore ≤ its affordable-set counterpart" — and it is the
 * quantity the two availability halves are derived from, so a violation shows up
 * here first.
 *
 * The turn-level union is asserted separately from the rows because it ranges over
 * the arrangements the turn could become rather than over the rows: it is monotone
 * because those arrangements' MEMBERSHIP is fixed by the selection and each one's
 * verdict is monotone in `(funding, basis)`. Whoever makes the union a function of
 * which entries are runnable reintroduces a second, funding-dependent input to it,
 * and this assertion is what catches that.
 */
function expectSubset(pair: TurnOptions): void {
  for (const option of EFFORT_OPTION_IDS) {
    if (turnOptionAvailableIn(pair.admissible, option)) {
      expect(turnOptionAvailableIn(pair.affordable, option)).toBe(true);
    }
  }
  for (const model of CATALOG) {
    if (availabilityOf(pair.admissible, model.modelId)) {
      expect(availabilityOf(pair.affordable, model.modelId)).toBe(true);
    }
    const admissibleCeiling = ceilingOf(pair.admissible, model.modelId);
    const affordableCeiling = ceilingOf(pair.affordable, model.modelId);
    if (admissibleCeiling !== undefined && affordableCeiling !== undefined) {
      expect(affordableCeiling).toBeGreaterThanOrEqual(admissibleCeiling);
    }
    const rungs = dimensionSupportFor(EFFORT_DIMENSION, model).options;
    const gained = rungs.filter(
      (option) =>
        optionAvailableIn(pair.admissible, model.modelId, option.optionId) &&
        !optionAvailableIn(pair.affordable, model.modelId, option.optionId)
    );
    expect(gained).toEqual([]);
  }
}

/** What one draw contributed to the sweep's own coverage controls. */
interface DrawShape {
  readonly sendable: boolean;
  readonly setsDiffer: boolean;
  readonly smartSlotBesidePinned: boolean;
  readonly candidatesFlipped: boolean;
}

function shapeOf(pair: TurnOptions, selection: Selection): DrawShape {
  const smartSlotBesidePinned = isSmartSlotBesidePinned(selection);
  return {
    sendable: pair.admissible.sendable,
    setsDiffer: pair.admissible.sendable !== pair.affordable.sendable,
    smartSlotBesidePinned,
    candidatesFlipped: smartSlotBesidePinned && candidateSetsDiffer(pair, selection),
  };
}

function countShapes(shapes: readonly DrawShape[], key: keyof DrawShape): number {
  return shapes.filter((shape) => shape[key]).length;
}

describe('admissible is a subset of affordable', () => {
  it('holds over 400 generated funding/prompt/selection triples', () => {
    const rng = mulberry32(0x5f_3a_11_07);
    const shapes: DrawShape[] = [];
    for (let iteration = 0; iteration < 400; iteration += 1) {
      const spendable = BigInt(intBetween(rng, 0, 400)) * 1_000_000n;
      const held = BigInt(intBetween(rng, 0, 400)) * 1_000_000n;
      const selection = selectionOf(rng);
      const options = getTurnOptions(
        {
          spendableNanoUsd: nanoUSD(spendable),
          heldNanoUsd: nanoUSD(held),
          tier: pick(rng, TIERS),
          payer: 'self',
        },
        basisOf(rng),
        selection,
        { models: CATALOG, nowMs: NOW_MS }
      );

      shapes.push(shapeOf(options, selection));
      // A sendable admissible set with an unsendable affordable one is the
      // set-level half of the subset relation.
      expect(options.admissible.sendable && !options.affordable.sendable).toBe(false);
      expectSubset(options);
    }
    // A sweep where nothing was ever sendable, or where the two sets never
    // diverged, would satisfy the subset check without constraining anything.
    expect(countShapes(shapes, 'sendable')).toBeGreaterThan(20);
    expect(countShapes(shapes, 'setsDiffer')).toBeGreaterThan(5);
    // And a sweep that never draws a smart slot beside a pinned sibling, or
    // never sees the candidate set move between the passes, leaves the grading
    // arrangement unconstrained however many draws it makes.
    expect(countShapes(shapes, 'smartSlotBesidePinned')).toBeGreaterThan(20);
    expect(countShapes(shapes, 'candidatesFlipped')).toBeGreaterThan(5);
  });
});

describe('the basis leg alone is monotone', () => {
  it('never gains availability or ceiling from a longer prompt at identical funding', () => {
    // Holding the whole balance spendable makes the two passes differ ONLY in
    // basis: (effectiveBalance, empty) against (effectiveBalance, composed). The
    // subset sweep above moves both inputs at once, so this isolates the leg the
    // funding difference would otherwise mask — and it carries the OPTION half,
    // because a model can keep its entry while a rung moves underneath it.
    const rng = mulberry32(0x77_ab_cd_02);
    let differingCount = 0;
    let smartSlotBesidePinnedCount = 0;
    for (let iteration = 0; iteration < 200; iteration += 1) {
      const balance = BigInt(intBetween(rng, 0, 600)) * 1_000_000n;
      const selection = selectionOf(rng);
      const options = getTurnOptions(
        {
          spendableNanoUsd: nanoUSD(balance),
          heldNanoUsd: nanoUSD(0n),
          tier: pick(rng, TIERS),
          payer: 'self',
        },
        basisOf(rng),
        selection,
        { models: CATALOG, nowMs: NOW_MS }
      );
      if (options.admissible.sendable !== options.affordable.sendable) differingCount += 1;
      if (isSmartSlotBesidePinned(selection)) smartSlotBesidePinnedCount += 1;
      expectSubset(options);
    }
    expect(differingCount).toBeGreaterThan(5);
    expect(smartSlotBesidePinnedCount).toBeGreaterThan(20);
  });
});

describe('a pinned sibling is graded on a monotone arrangement', () => {
  /** The turn the regression below is pinned on: one pinned sibling, one open slot. */
  const PINNED_WITH_SMART_SLOT: Selection = {
    answerSources: { models: [modelId('vendor/a-cheap')], smartSlot: true },
    modality: 'text',
    pinned: {},
    webSearch: false,
  };

  const LONG_BASIS: PromptBasis = {
    systemChars: 2000,
    instructionChars: 500,
    historyChars: 40_000,
    inputChars: 1000,
    attachmentBytes: 0,
  };

  function pairAt(spendable: bigint, held: bigint, basis: PromptBasis): TurnOptions {
    return getTurnOptions(
      {
        spendableNanoUsd: nanoUSD(spendable),
        heldNanoUsd: nanoUSD(held),
        tier: 'paid',
        payer: 'self',
      },
      basis,
      PINNED_WITH_SMART_SLOT,
      { models: CATALOG, nowMs: NOW_MS }
    );
  }

  it('solves the pinned sibling`s own arrangement, not the one the hold is sized for', () => {
    // Held is zero, so the two passes differ ONLY in basis. Grading the pinned
    // entry on the worst VIABLE candidate inverts this pair: the richer,
    // prompt-free pass clears a costlier candidate into viability, that candidate
    // becomes the arrangement the pinned sibling is graded on, and the affordable
    // ceiling lands BELOW the admissible one. On the pinned siblings' own
    // arrangement both passes reach the model's 64,000-token provider cap, which
    // is the ceiling a payer with this balance can genuinely buy on it.
    const pair = pairAt(93_000_000n, 0n, LONG_BASIS);
    expect(ceilingOf(pair.affordable, 'vendor/a-cheap')).toBe(64_000);
    expect(ceilingOf(pair.admissible, 'vendor/a-cheap')).toBe(64_000);
    expectSubset(pair);
  });

  it('never greys a rung in the picker that the send gate offers', () => {
    // Read at the turn level, which is where an effort control reads a rung for a
    // pinned sibling: the row carries the sibling's own verdict, and the menu ANDs
    // over the pinned siblings inside an OR over the arrangements the turn could
    // become. Both arms must offer the rung this balance can buy.
    const pair = pairAt(93_000_000n, 0n, LONG_BASIS);
    expect(turnOptionAvailableIn(pair.admissible, 'medium')).toBe(true);
    expect(turnOptionAvailableIn(pair.affordable, 'medium')).toBe(true);
  });

  it('never shrinks a pinned sibling`s ceiling as the balance rises', () => {
    // §Affordability 6 in its contrapositive form: a rising balance may only
    // grow what is presented. The sweep steps through the balances where a
    // candidate crosses into viability, which is where a funding-dependent
    // choice of grading arrangement inverts.
    let previous = 0;
    for (let millicents = 0; millicents <= 600; millicents += 1) {
      const ceiling = ceilingOf(
        pairAt(BigInt(millicents) * 1_000_000n, 0n, LONG_BASIS).affordable,
        'vendor/a-cheap'
      );
      expect(ceiling ?? 0).toBeGreaterThanOrEqual(previous);
      previous = ceiling ?? 0;
    }
    expect(previous).toBeGreaterThan(0);
  });
});

/** One entry's presented rungs, exactly as offered — nothing dropped. */
function expectEntryComplete(entry: CandidateModelEntry): number {
  const model = CATALOG.find((candidate) => candidate.modelId === entry.modelId);
  expect(model).toBeDefined();
  if (model === undefined) return 0;
  const offered = dimensionSupportFor(EFFORT_DIMENSION, model).options;
  const presented = entry.dimensions.flatMap((dimension) => dimension.options);
  expect(presented.map((option) => option.optionId)).toEqual(
    offered.map((option) => option.optionId)
  );
  const greyed = presented.filter((option) => !option.availability.available);
  for (const option of greyed) expect(option.availability).toHaveProperty('reason');
  return greyed.length;
}

/**
 * Returns how many options were marked unavailable and how many rows carried an
 * option list, both for the sweep's own controls. Asserted on BOTH arms of the
 * union: a set that refuses the turn still has to carry every row and every rung,
 * because a payer who cannot send is exactly the payer who needs the greying
 * explained (§Affordability, notion 1).
 *
 * Every row is asserted present; rungs are asserted on the candidate rows, which
 * are the only kind carrying them.
 */
function expectNothingFiltered(set: OptionSet): {
  readonly greyed: number;
  readonly rowsWithRungs: number;
} {
  const byId = (ids: readonly string[]): readonly string[] =>
    [...ids].toSorted((left, right) => left.localeCompare(right));
  expect(byId(set.all.map((entry) => entry.modelId))).toEqual(byId(MODEL_IDS));
  let greyed = 0;
  let rowsWithRungs = 0;
  for (const entry of set.all) {
    if (entry.kind !== 'candidate') continue;
    greyed += expectEntryComplete(entry);
    rowsWithRungs += 1;
  }
  return { greyed, rowsWithRungs };
}

/**
 * The feasible set of an ORDERED dimension is a downward-closed prefix, and that
 * is what makes a single "up to X" ceiling a lossless representation of it
 * (`docs/BILLING.md` §Ordering, enumerability). A hole would mean the ceiling
 * form silently drops a feasible rung, or presents an infeasible one — and the
 * classifier is handed exactly that set, so a hole is a `presented ⟺ feasible`
 * break rather than a display bug.
 *
 * The prefix is asserted in the DOMAIN's order, which is the requirement order
 * for a partition dimension: the off rung sits below every canonical level, so
 * enabling Low while Min is greyed is exactly the gap this looks for.
 */
const effortPosition = (optionId: string): number =>
  EFFORT_OPTION_IDS.indexOf(optionId as (typeof EFFORT_OPTION_IDS)[number]);

/** Every candidate row's effort rungs, ascending by the declared domain order. */
function effortRungsOf(set: OptionSet): readonly (readonly boolean[])[] {
  return entriesOf(set)
    .filter((entry): entry is CandidateModelEntry => entry.kind === 'candidate')
    .flatMap((entry) => entry.dimensions.filter((one) => one.dimensionId === 'effort'))
    .map((dimension) =>
      [...dimension.options]
        .toSorted((a, b) => effortPosition(a.optionId) - effortPosition(b.optionId))
        .map((option) => option.availability.available)
    );
}

/** Whether one row's availability flags form a downward-closed prefix — no holes. */
function isPrefix(flags: readonly boolean[]): boolean {
  const firstUnavailable = flags.indexOf(false);
  return firstUnavailable === -1 || !flags.slice(firstUnavailable).includes(true);
}

describe('an ordered dimension`s feasible set is a downward-closed prefix', () => {
  it('never leaves a gap, on either set, across 200 generated turns', () => {
    const rng = mulberry32(0x2b_7d_90_41);
    const rows: (readonly boolean[])[] = [];
    for (let iteration = 0; iteration < 200; iteration += 1) {
      const spendable = BigInt(intBetween(rng, 0, 300)) * 1_000_000n;
      const options = getTurnOptions(
        {
          spendableNanoUsd: nanoUSD(spendable),
          heldNanoUsd: nanoUSD(BigInt(intBetween(rng, 0, 200)) * 1_000_000n),
          tier: pick(rng, TIERS),
          payer: 'self',
        },
        basisOf(rng),
        selectionOf(rng),
        { models: CATALOG, nowMs: NOW_MS }
      );
      rows.push(...effortRungsOf(options.affordable), ...effortRungsOf(options.admissible));
    }
    expect(rows.filter((flags) => !isPrefix(flags))).toEqual([]);
    // A sweep where every rung was available on every row would satisfy the
    // prefix check without ever exercising a boundary.
    expect(rows.length).toBeGreaterThan(200);
    const partial = rows.filter((flags) => flags.includes(true) && flags.includes(false));
    expect(partial.length).toBeGreaterThan(10);
  });
});

describe('options are marked, never filtered', () => {
  it('presents every catalog model and every offered rung at every balance', () => {
    const rng = mulberry32(0x11_22_33_44);
    let greyedCount = 0;
    let rowsWithRungsCount = 0;
    for (let iteration = 0; iteration < 150; iteration += 1) {
      const spendable = BigInt(intBetween(rng, 0, 2000)) * 1_000_000n;
      const options = getTurnOptions(
        {
          spendableNanoUsd: nanoUSD(spendable),
          heldNanoUsd: nanoUSD(0n),
          tier: pick(rng, TIERS),
          payer: 'self',
        },
        basisOf(rng),
        selectionOf(rng),
        { models: CATALOG, nowMs: NOW_MS }
      );
      for (const set of [options.affordable, options.admissible]) {
        const counted = expectNothingFiltered(set);
        greyedCount += counted.greyed;
        rowsWithRungsCount += counted.rowsWithRungs;
      }
    }
    // Marking is only meaningful if something was actually marked unavailable, and
    // rung completeness is only meaningful if rows carrying rungs were reached.
    expect(greyedCount).toBeGreaterThan(0);
    expect(rowsWithRungsCount).toBeGreaterThan(100);
  });
});
