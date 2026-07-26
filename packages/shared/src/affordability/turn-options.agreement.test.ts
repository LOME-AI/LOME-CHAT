/**
 * The four readings of "what is presented or possible" agree pairwise.
 *
 * The producer publishes four of them — a row's availability, the turn-level
 * dimension union, the send gate, and the domain the hold's `MAX` is taken over
 * — and each one is a decision: what the classifier may pick, what the user may
 * pick, what the server admits, what money is reserved. Two of them computed from
 * different derivations disagree silently and repeatedly, and each disagreement is
 * a money or a menu defect, so the agreements are asserted as properties over
 * generated turns rather than spot-checked on a fixture. The pairs, named:
 *
 * - **union ↔ send gate** — a rung the menu enables is a rung a pin of that rung
 *   can send (§Reasoning Effort 3: "the same predicate the server admits on, so
 *   a menu can never enable a level the server refuses"). Universal in that
 *   direction, and a strict biconditional carrying the REASON on the shape where
 *   the classifier reserve cannot move between the two calls — see
 *   {@link reserveIsPinInvariant}.
 * - **send gate ↔ hold** — a hold exists exactly when the turn can start.
 * - **rows ↔ send gate** — the turn sends exactly when every selected row is
 *   available and, with a smart slot, some candidate row is.
 * - **a row's rungs ↔ that row's verdict** — a rung is presented on a row iff
 *   pinning that rung leaves the row presented. The row's rungs are the ceiling a
 *   classifier answer clamps onto, so a rung above the row's own verdict at it
 *   would clamp a joint pick onto a rung the arrangement cannot honour.
 *
 * Both arms of the pair are swept, because `affordable` and `admissible` are two
 * evaluations of one core and a reading that agrees on one funding number can
 * still disagree on the other.
 *
 * Every property is measured through the producer — the same turn re-produced with
 * a rung pinned — so nothing here re-implements pricing to check pricing.
 */

import { describe, expect, it } from 'vitest';

import { intBetween, mulberry32, pick } from '../__tests__/seeded-prng.js';
import { EFFORT_OPTION_IDS } from './dimensions/effort.js';
import { nanoUSD } from './nano-usd.js';
import { getTurnOptions } from './turn-options.js';
import type { Rng } from '../__tests__/seeded-prng.js';
import type { OptionId } from './dimensions/index.js';
import type { PriceableModel } from './priceable-model.js';
import type {
  FundingSnapshot,
  OptionSet,
  PromptBasis,
  RefusalCode,
  Selection,
  TurnOptions,
} from './turn-types.js';

/**
 * Shapes chosen so both arms of every property below occur: a wide cap that fits
 * High's budget, a narrow cap that fits Low's and not Mid's (the quantifier
 * fixture — one sibling honours a rung the other cannot), a mandatory-reasoning
 * model whose cheapest corner is not free, a model with no ladder at all, and a
 * dear one that starves its siblings.
 */
const CATALOG: readonly PriceableModel[] = [
  {
    modelId: 'v/wide',
    inputRateNanoUsd: nanoUSD(60n),
    outputRateNanoUsd: nanoUSD(150n),
    contextLength: 200_000,
    providerCap: 64_000,
    reasoning: { supportedEfforts: ['high', 'medium', 'low'] },
  },
  {
    modelId: 'v/narrow',
    inputRateNanoUsd: nanoUSD(200n),
    outputRateNanoUsd: nanoUSD(500n),
    contextLength: 128_000,
    providerCap: 9000,
    reasoning: { supportedEfforts: ['high', 'medium', 'low'] },
  },
  {
    modelId: 'v/mandatory',
    inputRateNanoUsd: nanoUSD(2500n),
    outputRateNanoUsd: nanoUSD(9000n),
    contextLength: 32_000,
    providerCap: 20_000,
    reasoning: { supportedEfforts: ['high', 'medium', 'low'], mandatory: true },
  },
  {
    modelId: 'v/plain',
    inputRateNanoUsd: nanoUSD(800n),
    outputRateNanoUsd: nanoUSD(1600n),
    contextLength: 128_000,
    providerCap: 8000,
    reasoning: undefined,
  },
  {
    modelId: 'v/dear',
    inputRateNanoUsd: nanoUSD(20_000n),
    outputRateNanoUsd: nanoUSD(90_000n),
    contextLength: 64_000,
    providerCap: 32_000,
    reasoning: { supportedEfforts: ['high', 'low'] },
  },
];

const MODEL_IDS = CATALOG.map((model) => model.modelId);
const TIERS = ['paid', 'free', 'trial', 'guest'] as const;
const EFFORT_PINS = [undefined, 'off', 'low', 'medium', 'high'] as const;

function basisOf(rng: Rng): PromptBasis {
  return {
    systemChars: intBetween(rng, 0, 3000),
    instructionChars: intBetween(rng, 0, 1000),
    historyChars: intBetween(rng, 0, 60_000),
    inputChars: intBetween(rng, 0, 3000),
    attachmentBytes: 0,
  };
}

function selectionOf(rng: Rng): Selection {
  const models = MODEL_IDS.filter(() => rng() > 0.6).slice(0, 3);
  const smartSlot = models.length === 0 ? true : rng() > 0.4;
  const pin = pick(rng, EFFORT_PINS);
  return {
    answerSources: smartSlot
      ? { models, smartSlot: true }
      : { models: [models[0] ?? MODEL_IDS[0] ?? '', ...models.slice(1)], smartSlot: false },
    modality: 'text',
    pinned: pin === undefined ? {} : { effort: pin },
    webSearch: rng() > 0.75,
  };
}

/** The same selection with one rung pinned — the turn the send gate would judge. */
function pinnedTo(selection: Selection, optionId: OptionId): Selection {
  return { ...selection, pinned: { ...selection.pinned, effort: optionId } };
}

/**
 * Whether the classifier reserve is the same amount on the open turn and on a
 * turn with the effort rung pinned. A reserve is bought when ANY dimension is
 * open, so pinning effort on a turn whose only open dimension IS effort drops
 * it, which raises the pinned turn's shared token count by the reserve and lets
 * a money-bound rung that the menu greyed become sendable. With a smart slot
 * over two or more candidates the model dimension keeps the reserve bought
 * either way, so the two calls price identically and the agreement is exact in
 * both directions.
 */
function reserveIsPinInvariant(selection: Selection): boolean {
  const pinnedCount = selection.answerSources.models.length;
  return selection.answerSources.smartSlot && CATALOG.length - pinnedCount >= 2;
}

/** One rung's verdict in the turn-level menu, or `undefined` when unlisted. */
function rungVerdict(set: OptionSet, optionId: OptionId): boolean | undefined {
  return set.turnDimensions
    .find((dimension) => dimension.dimensionId === 'effort')
    ?.options.find((option) => option.optionId === optionId)?.availability.available;
}

function rungReason(set: OptionSet, optionId: OptionId): RefusalCode | undefined {
  const availability = set.turnDimensions
    .find((dimension) => dimension.dimensionId === 'effort')
    ?.options.find((option) => option.optionId === optionId)?.availability;
  return availability?.available === false ? availability.reason : undefined;
}

function refusalOf(set: OptionSet): RefusalCode | undefined {
  return set.sendable ? undefined : set.refusal;
}

function fundingOf(rng: Rng): FundingSnapshot {
  return {
    spendableNanoUsd: nanoUSD(BigInt(intBetween(rng, 0, 400)) * 1_000_000n),
    heldNanoUsd: nanoUSD(BigInt(intBetween(rng, 0, 200)) * 1_000_000n),
    tier: pick(rng, TIERS),
    payer: 'self',
  };
}

/** The two arms, so every property below is asserted on both evaluations. */
function armsOf(pair: TurnOptions): readonly (readonly [string, OptionSet])[] {
  return [
    ['affordable', pair.affordable],
    ['admissible', pair.admissible],
  ];
}

/** One arm of one draw, and the send gate to compare it against. */
interface Pairing {
  readonly arm: string;
  readonly set: OptionSet;
  /** The same turn with one rung pinned, on the same arm. */
  readonly gateFor: (optionId: OptionId) => OptionSet;
  /** Whether the two calls price identically — see {@link reserveIsPinInvariant}. */
  readonly strict: boolean;
}

/** What one draw contributed, so a sweep that proved nothing fails its own controls. */
interface Tally {
  enabled: number;
  greyed: number;
  reasonsChecked: number;
  rungsChecked: number;
  strictDraws: number;
  unsendable: number;
  slotBesidePinned: number;
}

function emptyTally(): Tally {
  return {
    enabled: 0,
    greyed: 0,
    reasonsChecked: 0,
    rungsChecked: 0,
    strictDraws: 0,
    unsendable: 0,
    slotBesidePinned: 0,
  };
}

/**
 * The union ↔ send-gate pair, on one arm. Every listed rung is re-produced with
 * that rung pinned and the arm's own verdict compared: enabling a rung the gate
 * refuses is the defect §Reasoning Effort 3 forbids outright, and on the
 * reserve-invariant shape the greyed rungs must carry the very reason the gate
 * would give.
 */
function expectMenuMatchesGate(pairing: Pairing, tally: Tally): void {
  const { arm, set, gateFor, strict } = pairing;
  for (const optionId of EFFORT_OPTION_IDS) {
    const enabled = rungVerdict(set, optionId);
    if (enabled === undefined) continue;
    const gate = gateFor(optionId);
    if (enabled) {
      expect(`${arm}:${optionId}:${String(gate.sendable)}`).toBe(`${arm}:${optionId}:true`);
      tally.enabled += 1;
      continue;
    }
    tally.greyed += 1;
    if (!strict) continue;
    expect(`${arm}:${optionId}:${String(gate.sendable)}`).toBe(`${arm}:${optionId}:false`);
    expect(`${arm}:${optionId}:${String(rungReason(set, optionId))}`).toBe(
      `${arm}:${optionId}:${String(refusalOf(gate))}`
    );
    tally.reasonsChecked += 1;
  }
}

/**
 * The pair inside one row: a rung is presented on a row iff pinning that rung
 * leaves the row presented. Both readings are decisions — the row's verdict is
 * what the classifier may pick, its rungs are the per-candidate ceiling a
 * classifier answer clamps onto (§Story 2.2, §Reasoning Effort 8) — so a rung
 * standing above the row's own verdict at that rung would clamp a joint pick onto
 * a rung the arrangement cannot honour.
 *
 * Scoped to the candidate rows because they are the rows that carry rungs at all:
 * a pinned sibling is already chosen, so nothing picks a rung on it and the type
 * publishes none.
 */
function expectRungsMatchRows(pairing: Pairing, tally: Tally): void {
  const { arm, set, gateFor } = pairing;
  for (const entry of set.all) {
    if (entry.kind !== 'candidate') continue;
    for (const option of entry.dimensions.flatMap((dimension) => dimension.options)) {
      const rowUnderPin = gateFor(option.optionId).all.find(
        (candidate) => candidate.modelId === entry.modelId
      );
      expect(
        `${arm}:${entry.modelId}:${option.optionId}:${String(option.availability.available)}`
      ).toBe(
        `${arm}:${entry.modelId}:${option.optionId}:${String(rowUnderPin?.availability.available)}`
      );
      tally.rungsChecked += 1;
    }
  }
}

/** The rows ↔ send-gate pair: what sends is what the rows say can answer. */
function expectRowsMatchGate(arm: string, set: OptionSet, selection: Selection): void {
  const selectedIds = selection.answerSources.models;
  const available = (modelId: string): boolean =>
    set.all.some((entry) => entry.modelId === modelId && entry.availability.available);
  const everySelected = selectedIds.every((modelId) => available(modelId));
  const someCandidate = set.all.some(
    (entry) => !selectedIds.includes(entry.modelId) && entry.availability.available
  );
  const fromRows = everySelected && (!selection.answerSources.smartSlot || someCandidate);
  expect(`${arm}:${String(set.sendable)}`).toBe(`${arm}:${String(fromRows)}`);
}

/** One draw: produce the turn, then hold every pair against the same funding. */
function checkDraw(
  funding: FundingSnapshot,
  basis: PromptBasis,
  selection: Selection,
  tally: Tally
): void {
  const pair = getTurnOptions(funding, basis, selection, CATALOG);
  const strict = reserveIsPinInvariant(selection);
  if (strict) tally.strictDraws += 1;
  if (!pair.admissible.sendable) tally.unsendable += 1;
  if (selection.answerSources.smartSlot && selection.answerSources.models.length > 0) {
    tally.slotBesidePinned += 1;
  }

  // send gate ↔ hold: a hold is a value only a startable turn has.
  expect(pair.holdNanoUsd !== undefined).toBe(pair.admissible.sendable);

  const gates = new Map<OptionId, TurnOptions>();
  const gateArms = (optionId: OptionId): TurnOptions => {
    const cached = gates.get(optionId);
    if (cached !== undefined) return cached;
    const produced = getTurnOptions(funding, basis, pinnedTo(selection, optionId), CATALOG);
    gates.set(optionId, produced);
    return produced;
  };
  for (const [arm, set] of armsOf(pair)) {
    const gateFor = (optionId: OptionId): OptionSet => {
      const produced = gateArms(optionId);
      return arm === 'affordable' ? produced.affordable : produced.admissible;
    };
    const pairing: Pairing = { arm, set, gateFor, strict };
    expectRowsMatchGate(arm, set, selection);
    expectMenuMatchesGate(pairing, tally);
    // A row's rungs are its own verdict at those rungs, which is exact only where
    // the two calls price identically.
    if (strict) expectRungsMatchRows(pairing, tally);
  }
}

describe('the four readings agree pairwise', () => {
  it('holds over 200 generated funding/prompt/selection triples', () => {
    const rng = mulberry32(0x3c_71_0d_55);
    const tally = emptyTally();
    for (let iteration = 0; iteration < 200; iteration += 1) {
      checkDraw(fundingOf(rng), basisOf(rng), selectionOf(rng), tally);
    }
    // A sweep that never enabled a rung, never greyed one, never reached the
    // strict shape, or never saw an unsendable turn satisfies every property
    // above while constraining nothing.
    expect(tally.enabled).toBeGreaterThan(100);
    expect(tally.greyed).toBeGreaterThan(100);
    expect(tally.reasonsChecked).toBeGreaterThan(50);
    expect(tally.rungsChecked).toBeGreaterThan(500);
    expect(tally.strictDraws).toBeGreaterThan(20);
    expect(tally.unsendable).toBeGreaterThan(20);
    expect(tally.slotBesidePinned).toBeGreaterThan(20);
  });
});
