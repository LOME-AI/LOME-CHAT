/**
 * `minTurnCost` pinned two ways: BY AMOUNT, so the composition cannot lose a
 * term silently, and BY THE BICONDITIONAL it exists to satisfy — funding equal
 * to it makes the turn sendable, funding one nano below it does not. The second
 * is what makes it the RIGHT threshold rather than merely a smaller one: a payer
 * decision taken on a number that clears the corner but not the hold admits a
 * turn admission then refuses, forever.
 *
 * The biconditional is asked of `getTurnOptions`, so it is an assertion about
 * the ceiling solve AS PRODUCTION COMPOSES IT. Asking the arithmetic primitives
 * directly would pin the same terms in a second arrangement of this file's own
 * making, which stays green through any change to the real one.
 */

import { describe, expect, it } from 'vitest';

import { MINIMUM_OUTPUT_TOKENS } from './constants.js';
import { minTurnCostNanoUsd } from './min-turn-cost.js';
import { modelId } from './model-id.js';
import { nanoUSD } from './nano-usd.js';
import { PREMIUM_RECENCY_MS } from './premium.js';
import { getTurnOptions } from './turn-options.js';
import { WEB_SEARCH_RESERVATION_NANO_PER_MODEL } from './estimate/search-reservation.js';
import type { MinTurnCostInput } from './min-turn-cost.js';
import type { ModelId } from './model-id.js';
import type { PriceableModel } from './priceable-model.js';
import type { NonEmpty, PromptBasis, TurnOptions } from './turn-types.js';

/** 100 nano per input token, 200 per output token — round numbers on purpose. */
const MODEL: PriceableModel = {
  modelId: modelId('vendor/base'),
  inputRateNanoUsd: nanoUSD(100n),
  outputRateNanoUsd: nanoUSD(200n),
  contextLength: 100_000,
  providerCap: 8000,
  releasedAtMs: 0,
  reasoning: undefined,
};

/**
 * The same rates, but reasoning cannot be turned off: `e_min` costs tokens. Its
 * provider cap is wide enough to hold that rung AND a minimum answer — a
 * mandatory-reasoning model whose cap cannot hold both is ineligible at every
 * funding level, which is a capability refusal rather than a money one.
 */
const MANDATORY_MODEL: PriceableModel = {
  ...MODEL,
  modelId: modelId('vendor/mandatory'),
  providerCap: 40_000,
  reasoning: { mandatory: true, supportedEfforts: ['high'] },
};

/** `B(m, e_min)` for {@link MANDATORY_MODEL}: the High rung, under its cap. */
const MANDATORY_REASONING_TOKENS = 32_768;

/** 400 prompt characters exactly, so the paid ratio (4) divides cleanly. */
const PROMPT_CHARS = 400;

function inputFor(overrides: Partial<MinTurnCostInput> = {}): MinTurnCostInput {
  return {
    siblings: [MODEL],
    promptChars: PROMPT_CHARS,
    tier: 'paid',
    persists: true,
    classifierReserveNanoUsd: 0n,
    webSearch: false,
    ...overrides,
  };
}

/** The measured total as the §Math & Terms basis sees it. */
function basisOf(promptChars: number): PromptBasis {
  return {
    systemChars: 0,
    instructionChars: 0,
    historyChars: 0,
    inputChars: promptChars,
    attachmentBytes: 0,
  };
}

/**
 * The same turn, put through the ONE producer at a given funding number.
 * `admissible` is the set the send gate reads, so a `sendable` verdict here is
 * the verdict production takes.
 *
 * Only the translation lives in this helper, and it carries one obligation the
 * types cannot: the producer derives persistence from the tier
 * (`tier !== 'trial'`), so a case must keep {@link MinTurnCostInput.persists}
 * consistent with its tier or the two sides price different turns.
 */
function optionsAt(input: MinTurnCostInput, fundingNanoUsd: bigint): TurnOptions {
  const models: NonEmpty<ModelId> = [
    input.siblings[0].modelId,
    ...input.siblings.slice(1).map((model) => model.modelId),
  ];
  return getTurnOptions(
    {
      spendableNanoUsd: nanoUSD(fundingNanoUsd),
      heldNanoUsd: nanoUSD(0n),
      payerTier: input.tier,
      payer: 'self',
    },
    basisOf(input.promptChars),
    {
      answerSources: { models, smartSlot: false },
      modality: 'text',
      pinned: {},
      webSearch: input.webSearch,
    },
    // The pool is the siblings themselves: too small to carry a price
    // threshold, and released at the epoch, so neither premium leg fires and no
    // tier-access refusal is confounded with the money one being pinned.
    { models: input.siblings, nowMs: PREMIUM_RECENCY_MS }
  );
}

/** The hold the producer would take at that funding, in nano-USD. */
function holdAt(input: MinTurnCostInput, fundingNanoUsd: bigint): bigint | undefined {
  const { holdNanoUsd } = optionsAt(input, fundingNanoUsd);
  return holdNanoUsd === undefined ? undefined : BigInt(holdNanoUsd);
}

describe('minTurnCostNanoUsd — the eligible corner, by amount', () => {
  it('prices input tokens, input storage and a minimum answer for one model', () => {
    // 400 chars at 4 chars/token (paid) = 100 input tokens × 100 nano = 10,000.
    // Input storage: 400 chars × 300 nano = 120,000.
    // Output: 1,000 minimum tokens × (200 provider + 2 chars × 300 storage) = 800,000.
    expect(minTurnCostNanoUsd(inputFor())).toBe(930_000n);
  });

  it('drops both storage terms on a turn that does not persist', () => {
    // Provider legs only: 10,000 input + 1,000 × 200 output = 210,000.
    expect(minTurnCostNanoUsd(inputFor({ persists: false }))).toBe(210_000n);
  });

  it('prices the input leg at the conservative ratio for a non-paid tier', () => {
    // 400 chars at 2 chars/token = 200 input tokens × 100 = 20,000; output
    // storage inverts to 4 chars/token, so the variable rate is 200 + 1,200.
    expect(minTurnCostNanoUsd(inputFor({ tier: 'free' }))).toBe(1_540_000n);
  });

  it('adds the classifier reserve as a fixed term', () => {
    expect(minTurnCostNanoUsd(inputFor({ classifierReserveNanoUsd: 7n }))).toBe(930_007n);
  });

  it("adds the web-search reservation per sibling when the turn's search tool is on", () => {
    expect(minTurnCostNanoUsd(inputFor({ webSearch: true }))).toBe(
      930_000n + WEB_SEARCH_RESERVATION_NANO_PER_MODEL
    );
  });

  it('reserves the cheapest reasoning rung a mandatory-reasoning model must spend', () => {
    // `e_min` is the model's lowest offered rung — thinking tokens on top of
    // the 1,000-token minimum answer, both billed at the output rate.
    const corner = BigInt(MANDATORY_REASONING_TOKENS + MINIMUM_OUTPUT_TOKENS);
    expect(minTurnCostNanoUsd(inputFor({ siblings: [MANDATORY_MODEL] }))).toBe(
      10_000n + 120_000n + corner * 800n
    );
  });
});

describe('minTurnCostNanoUsd — the biconditional', () => {
  // The classifier reserve has no case here on purpose: the producer DERIVES it
  // from the catalog and the open dimensions, so no case can hand it one, and
  // handing it a figure this file computed would be the re-composition the
  // biconditional exists to avoid. Its amount is pinned above instead.
  const cases: readonly { readonly name: string; readonly input: MinTurnCostInput }[] = [
    { name: 'one model', input: inputFor() },
    {
      name: 'a trial turn, which stores nothing',
      input: inputFor({ tier: 'trial', persists: false }),
    },
    { name: 'a free-tier payer', input: inputFor({ tier: 'free' }) },
    { name: 'a turn with web search on', input: inputFor({ webSearch: true }) },
    {
      name: 'a mandatory-reasoning model',
      input: inputFor({ siblings: [MANDATORY_MODEL] }),
    },
    {
      name: 'siblings whose cheapest corners differ',
      input: inputFor({ siblings: [MODEL, MANDATORY_MODEL] as NonEmpty<PriceableModel> }),
    },
  ];

  it.each(cases)('funding equal to it leaves the turn sendable — $name', ({ input }) => {
    expect(optionsAt(input, minTurnCostNanoUsd(input)).admissible.sendable).toBe(true);
  });

  // Asserting the REASON, not merely the refusal: a red that arrives because
  // the prompt is too long or the model's cap is too low would satisfy
  // `sendable === false` while saying nothing about the threshold.
  it.each(cases)('one nano below it refuses for want of money — $name', ({ input }) => {
    const set = optionsAt(input, minTurnCostNanoUsd(input) - 1n).admissible;
    expect(set.sendable ? 'sendable' : set.refusal).toBe('insufficient_funds');
  });

  it.each(cases)('the hold it buys never exceeds it — $name', ({ input }) => {
    const funding = minTurnCostNanoUsd(input);
    expect(holdAt(input, funding)).toBeLessThanOrEqual(funding);
  });
});
