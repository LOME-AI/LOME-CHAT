/**
 * The shared token count `T`, pinned BY AMOUNT on a saturating-sibling turn.
 *
 * §Sharing one budget across siblings fixes the order in which the two steps
 * happen: `T` is solved against the UNCLAMPED summed cost, and each sibling's own
 * physical bounds clamp afterwards. Where one sibling saturates its own room the
 * order is observable — a solve that clamped inside the sum would find a LARGER
 * `T` and hand the unsaturated sibling a longer answer — so the amounts below are
 * what distinguishes the two orders, and this file exists to make a change of
 * order fail rather than pass quietly.
 *
 * Three amounts are asserted, because each fails differently: the saturated
 * sibling's ceiling (its own cap, not `T`), the wide sibling's ceiling (`T`
 * itself, showing the tight sibling did not cap it), and the hold, which is
 * `Σᵢ cost(mᵢ, ceiling(mᵢ))` — never `T × Σrates` (§Multi-Model 2).
 */

import { describe, expect, it } from 'vitest';

import { modelId } from './model-id.js';
import { nanoUSD } from './nano-usd.js';
import { getTurnOptions } from './turn-options.js';
import type { PriceableModel } from './priceable-model.js';
import type { FundingSnapshot, PromptBasis, Selection } from './turn-types.js';

const NOW_MS = 1_800_000_000_000;

/** Saturates: its provider cap sits well below what the money buys. */
const TIGHT: PriceableModel = {
  modelId: modelId('vendor/tight'),
  inputRateNanoUsd: nanoUSD(100n),
  outputRateNanoUsd: nanoUSD(200n),
  contextLength: 200_000,
  providerCap: 2000,
  reasoning: undefined,
  releasedAtMs: 0,
};

/** Wide: nothing physical binds it, so it receives `T`. */
const WIDE: PriceableModel = {
  modelId: modelId('vendor/wide'),
  inputRateNanoUsd: nanoUSD(100n),
  outputRateNanoUsd: nanoUSD(200n),
  contextLength: 200_000,
  providerCap: 64_000,
  reasoning: undefined,
  releasedAtMs: 0,
};

const BASIS: PromptBasis = {
  systemChars: 600,
  instructionChars: 0,
  historyChars: 300,
  inputChars: 100,
  attachmentBytes: 0,
};

const SELECTION: Selection = {
  answerSources: {
    models: [modelId('vendor/tight'), modelId('vendor/wide')],
    smartSlot: false,
  },
  modality: 'text',
  pinned: {},
  webSearch: false,
};

const FUNDING: FundingSnapshot = {
  spendableNanoUsd: nanoUSD(20_000_000n),
  heldNanoUsd: nanoUSD(0n),
  payerTier: 'paid',
  payer: 'self',
};

const OPTIONS = getTurnOptions(FUNDING, BASIS, SELECTION, { models: [TIGHT, WIDE], nowMs: NOW_MS });

function ceilingOf(id: string): number | undefined {
  return OPTIONS.admissible.all.find((entry) => entry.modelId === id)?.ceilingTokens;
}

describe('one shared token count, clamped per sibling afterwards', () => {
  it('gives the saturating sibling its own cap rather than the shared count', () => {
    expect(ceilingOf('vendor/tight')).toBe(2000);
  });

  it('gives the wide sibling the shared count, uncapped by its tight sibling', () => {
    expect(ceilingOf('vendor/wide')).toBe(12_281);
  });

  it('holds the summed cost at each sibling own ceiling, not the shared count twice', () => {
    expect(OPTIONS.holdNanoUsd).toBe(11_774_800n);
  });

  it('holds no more than the funding it was solved against', () => {
    expect(OPTIONS.holdNanoUsd).toBeLessThanOrEqual(BigInt(FUNDING.spendableNanoUsd));
  });

  it('leaves funding unspent when a sibling saturates, rather than reallocating it', () => {
    // The observable consequence of solving `T` UNCLAMPED: the saturated
    // sibling's unused room is not handed to the wide one, so the hold comes out
    // strictly under the funding. A solve that clamped inside the sum would raise
    // `T` until the summed cost met the funding, which is the divergence this
    // file's amounts exist to catch.
    expect(BigInt(FUNDING.spendableNanoUsd) - (OPTIONS.holdNanoUsd ?? 0n)).toBe(8_225_200n);
  });
});
