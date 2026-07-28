/**
 * The two `T` clamp orders, compared BY AMOUNT on the saturating-sibling turn.
 *
 * §Sharing one budget across siblings solves the shared token count `T` against
 * the UNCLAMPED summed cost and clamps each sibling afterwards. The money module
 * implements exactly that, and pins its own amounts in
 * `turn-options.shared-ceiling.test.ts`. This server-side solver does not: its
 * fit prices the ALREADY-CLAMPED definition and raises the cap until the priced
 * total meets the funds, so a sibling that saturates its own room releases its
 * unused budget to the others.
 *
 * The orders therefore diverge, and this file exists to state by how much and in
 * which direction rather than to make them agree. It is not the
 * two-implementations-agree cross-check Global Constraint 5 bans — the opposite:
 * the assertions fail if the divergence closes silently or changes sign, and
 * either would mean one side moved without the other.
 *
 * The fixture is B8's, deliberately reused down to the rates and the funding, so
 * the amounts on the two sides are the same question asked twice.
 */

import { describe, expect, it } from 'vitest';
import { modelId, nanoUSD, spendableFundsNanoUsd } from '@hushbox/shared';
import { getTurnOptions } from '@hushbox/shared/affordability';
import { createEstimateRun } from '../../models/index.js';
import { compileMultiModelTurn, payerSpendableNanoUsd } from './turn-definition.js';
import type { TurnBudget } from './turn-definition.js';
import type { ModelPricingResolver } from '../../models/index.js';
import type { ModelDescriptor, Node } from '@hushbox/shared';

/**
 * The producer's own parameter types, read off the published export rather than
 * deep-imported: the money module's shapes reach this side through the barrel
 * only, and naming them any other way would widen the wall this run is closing.
 */
type FundingSnapshot = Parameters<typeof getTurnOptions>[0];
type PromptBasis = Parameters<typeof getTurnOptions>[1];
type Selection = Parameters<typeof getTurnOptions>[2];
type PriceableModel = Parameters<typeof getTurnOptions>[3]['models'][number];

const NOW_MS = 1_800_000_000_000;
const TIGHT_ID = 'vendor/tight';
const WIDE_ID = 'vendor/wide';

/** The one funding figure both sides are solved against. */
const SPENDABLE = 20_000_000n;

/** 600 system + 300 history + 100 input, the module fixture's basis. */
const PROMPT_CHARS = 1000;

const RATES = { input: 100n, output: 200n } as const;

function descriptorOf(id: string, providerCap: number): ModelDescriptor {
  return {
    id,
    provider: 'p',
    version: '1',
    inputs: ['text'],
    outputs: ['text'],
    parameters: {},
    behaviors: [],
    limits: { contextLength: 200_000, maxOutputTokens: providerCap },
    pricing: {
      inputPerToken: nanoUSD(RATES.input),
      outputPerToken: nanoUSD(RATES.output),
    },
    zdrReachable: true,
    releasedAt: 1_700_000_000,
    fetchedAt: 0,
  };
}

const CATALOG = [descriptorOf(TIGHT_ID, 2000), descriptorOf(WIDE_ID, 64_000)];
const resolve: ModelPricingResolver = (id) => CATALOG.find((model) => model.id === id);

function priceableOf(id: string, providerCap: number): PriceableModel {
  return {
    modelId: modelId(id),
    inputRateNanoUsd: nanoUSD(RATES.input),
    outputRateNanoUsd: nanoUSD(RATES.output),
    contextLength: 200_000,
    providerCap,
    reasoning: undefined,
    releasedAtMs: 0,
  };
}

const BASIS: PromptBasis = {
  systemChars: 600,
  instructionChars: 0,
  historyChars: 300,
  inputChars: 100,
  attachmentBytes: 0,
};

const SELECTION: Selection = {
  answerSources: { models: [modelId(TIGHT_ID), modelId(WIDE_ID)], smartSlot: false },
  modality: 'text',
  pinned: {},
  webSearch: false,
};

const FUNDING: FundingSnapshot = {
  spendableNanoUsd: nanoUSD(SPENDABLE),
  heldNanoUsd: nanoUSD(0n),
  tier: 'paid',
  payer: 'self',
};

const MODULE_SIDE = getTurnOptions(FUNDING, BASIS, SELECTION, {
  models: [priceableOf(TIGHT_ID, 2000), priceableOf(WIDE_ID, 64_000)],
  nowMs: NOW_MS,
});

/**
 * The server budget carrying the SAME spendable figure. The paid cushion is
 * added by `payerSpendableNanoUsd`, so the remainder is derived from the shared
 * function rather than from a hardcoded cushion — a cushion change moves both.
 */
const BUDGET: TurnBudget = {
  promptCharacterCount: PROMPT_CHARS,
  funding: {
    kind: 'purchased',
    remainingNanoUsd: SPENDABLE - spendableFundsNanoUsd(0n, 'paid'),
  },
};

const SERVER_SIDE = compileMultiModelTurn(resolve, [TIGHT_ID, WIDE_ID], {
  budget: BUDGET,
})._unsafeUnwrap();

function serverCapOf(model: string): number | undefined {
  const node = SERVER_SIDE.definition.nodes.find(
    (candidate): candidate is Extract<Node, { type: 'modelCall' }> =>
      candidate.type === 'modelCall' && candidate.model === model
  );
  const cap = node?.params['maxOutputTokens'];
  return typeof cap === 'number' ? cap : undefined;
}

function moduleCeilingOf(model: string): number | undefined {
  return MODULE_SIDE.admissible.all.find((entry) => entry.modelId === model)?.ceilingTokens;
}

const SERVER_HOLD = createEstimateRun(resolve)(SERVER_SIDE.definition)._unsafeUnwrap();

describe('the two clamp orders on one saturating-sibling turn', () => {
  it('agrees on the saturated sibling, which its own cap fixes either way', () => {
    // The tight sibling is bounded by its provider cap, not by the money, so no
    // clamp order can move it. Agreement here is what isolates the divergence
    // below to the ORDER rather than to the fixture.
    expect(moduleCeilingOf(TIGHT_ID)).toBe(2000);
    expect(serverCapOf(TIGHT_ID)).toBe(2000);
  });

  it('diverges on the wide sibling, and the server hands it the longer answer', () => {
    expect(moduleCeilingOf(WIDE_ID)).toBe(12_281);
    expect(serverCapOf(WIDE_ID)).toBe(22_562);
  });

  it('spends the saturated sibling unused budget instead of leaving it, unlike the module', () => {
    // The module leaves 8,225,200 nano unspent (its own pinned amount); the
    // server's fit reallocates all but 400 of it to the sibling that can use it.
    expect(BigInt(FUNDING.spendableNanoUsd) - (MODULE_SIDE.holdNanoUsd ?? 0n)).toBe(8_225_200n);
    expect(SPENDABLE - SERVER_HOLD).toBe(400n);
  });

  it('keeps the server hold inside the same funding the module solved against', () => {
    // The direction that makes the divergence safe: the fit gates on the SAME
    // spendable figure, so the larger cap can only lengthen an answer — it can
    // never admit a send the client refused, and never holds past the funds.
    expect(SERVER_HOLD).toBeLessThanOrEqual(SPENDABLE);
    expect(SERVER_HOLD).toBeGreaterThan(MODULE_SIDE.holdNanoUsd ?? 0n);
    expect(payerSpendableNanoUsd(BUDGET)).toBe(SPENDABLE);
  });

  it('never presents more than it runs, so the served ceiling is not a promise the run breaks', () => {
    // The presented ceiling is the SMALLER of the two here. An over-presented
    // ceiling degrades to a shorter answer (§Data Structures); this direction
    // cannot even do that.
    expect(moduleCeilingOf(WIDE_ID) ?? 0).toBeLessThanOrEqual(serverCapOf(WIDE_ID) ?? 0);
  });
});
