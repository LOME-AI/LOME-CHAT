/**
 * The one producer. Called once, with the composed basis; it substitutes the
 * empty basis for the `affordable` pass itself, so a prompt-dependent floor and
 * a hold-blind send gate are both unobtainable rather than merely discouraged.
 */

import { describe, expect, it, vi } from 'vitest';

import { modelId } from './model-id.js';
import type { ModelId } from './model-id.js';
import { nanoUSD } from './nano-usd.js';
import { ratesFromPricing } from './estimate/run-ceiling.js';
import { getTurnOptions } from './turn-options.js';
import { EMPTY_PROMPT_BASIS } from './turn-types.js';
import type { PriceableModel } from './priceable-model.js';
import type { FundingSnapshot, PromptBasis, Selection } from './turn-types.js';

/** A fixed instant: premium classification takes its clock as an argument. */
const NOW_MS = 1_800_000_000_000;

const spy = vi.hoisted(() => ({ record: vi.fn() }));

// The core is mocked TRANSPARENTLY — the factory delegates to the real
// implementation and only records its inputs — so every other assertion in this
// file still exercises the production arithmetic.
vi.mock('./turn-core.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./turn-core.js')>();
  return {
    ...actual,
    evaluateTurn: (input: Parameters<typeof actual.evaluateTurn>[0]) => {
      spy.record(input);
      return actual.evaluateTurn(input);
    },
  };
});

const PLAIN: PriceableModel = {
  modelId: modelId('vendor/plain'),
  inputRateNanoUsd: nanoUSD(1000n),
  outputRateNanoUsd: nanoUSD(2000n),
  contextLength: 100_000,
  providerCap: 8000,
  releasedAtMs: 0,
  reasoning: undefined,
};

const LADDER: PriceableModel = {
  modelId: modelId('vendor/ladder'),
  inputRateNanoUsd: nanoUSD(100n),
  outputRateNanoUsd: nanoUSD(200n),
  contextLength: 200_000,
  providerCap: 64_000,
  releasedAtMs: 0,
  reasoning: { supportedEfforts: ['high', 'medium', 'low'] },
};

/** 1,000 prompt characters exactly. */
const BASIS: PromptBasis = {
  systemChars: 600,
  instructionChars: 0,
  historyChars: 300,
  inputChars: 100,
  attachmentBytes: 0,
};

function fundingOf(spendable: bigint, held = 0n, payerTier: FundingSnapshot['payerTier'] = 'paid') {
  return {
    spendableNanoUsd: nanoUSD(spendable),
    heldNanoUsd: nanoUSD(held),
    payerTier,
    payer: 'self',
  } satisfies FundingSnapshot;
}

function selectionOf(models: readonly string[], overrides: Partial<Selection> = {}): Selection {
  return {
    answerSources: {
      models: models.map((id) => modelId(id)) as [ModelId, ...ModelId[]],
      smartSlot: false,
    },
    modality: 'text',
    pinned: {},
    webSearch: false,
    ...overrides,
  };
}

describe('the returned pair', () => {
  it('carries both sets and the hold the turn would place', () => {
    const options = getTurnOptions(
      fundingOf(1_000_000_000n),
      BASIS,
      selectionOf(['vendor/plain']),
      { models: [PLAIN], nowMs: NOW_MS }
    );
    expect(options.affordable.sendable).toBe(true);
    expect(options.admissible.sendable).toBe(true);
    expect(options.holdNanoUsd).toBe(21_350_000n);
  });

  it('carries no hold when the turn cannot start', () => {
    const options = getTurnOptions(fundingOf(1000n), BASIS, selectionOf(['vendor/plain']), {
      models: [PLAIN],
      nowMs: NOW_MS,
    });
    expect(options.admissible.sendable).toBe(false);
    expect(options.holdNanoUsd).toBeUndefined();
  });
});

describe('one call, two evaluations', () => {
  it('runs the core exactly twice per call', () => {
    spy.record.mockClear();
    getTurnOptions(fundingOf(1_000_000_000n), BASIS, selectionOf(['vendor/plain']), {
      models: [PLAIN],
      nowMs: NOW_MS,
    });
    expect(spy.record).toHaveBeenCalledTimes(2);
  });

  it('supplies the empty basis on the affordable pass and the composed basis on the other', () => {
    spy.record.mockClear();
    getTurnOptions(fundingOf(1_000_000_000n), BASIS, selectionOf(['vendor/plain']), {
      models: [PLAIN],
      nowMs: NOW_MS,
    });
    const [first, second] = spy.record.mock.calls;
    expect(first?.[0]).toMatchObject({ basis: EMPTY_PROMPT_BASIS });
    expect(second?.[0]).toMatchObject({ basis: BASIS });
  });

  it('funds the affordable pass hold-blind and the admissible pass hold-aware', () => {
    spy.record.mockClear();
    getTurnOptions(fundingOf(600_000_000n, 400_000_000n), BASIS, selectionOf(['vendor/plain']), {
      models: [PLAIN],
      nowMs: NOW_MS,
    });
    const [first, second] = spy.record.mock.calls;
    // effectiveBalance = spendable + held; spendable alone gates the send.
    expect(first?.[0]).toMatchObject({ fundingNanoUsd: 1_000_000_000n });
    expect(second?.[0]).toMatchObject({ fundingNanoUsd: 600_000_000n });
  });
});

describe('the floor is prompt-independent', () => {
  it('is byte-identical across a keystroke sweep', () => {
    const funding = fundingOf(30_000_000n);
    const baseline = getTurnOptions(funding, BASIS, selectionOf(['vendor/ladder']), {
      models: [LADDER, PLAIN],
      nowMs: NOW_MS,
    }).affordable;
    for (let typed = 0; typed <= 40; typed += 8) {
      const options = getTurnOptions(
        funding,
        { ...BASIS, inputChars: BASIS.inputChars + typed },
        selectionOf(['vendor/ladder']),
        { models: [LADDER, PLAIN], nowMs: NOW_MS }
      );
      expect(options.affordable).toEqual(baseline);
    }
  });

  it('moves as the prompt grows on the admissible side, which is what makes the pin above meaningful', () => {
    const funding = fundingOf(30_000_000n);
    const short = getTurnOptions(funding, BASIS, selectionOf(['vendor/ladder']), {
      models: [LADDER, PLAIN],
      nowMs: NOW_MS,
    });
    const long = getTurnOptions(
      funding,
      { ...BASIS, historyChars: 80_000 },
      selectionOf(['vendor/ladder']),
      { models: [LADDER, PLAIN], nowMs: NOW_MS }
    );
    expect(long.admissible).not.toEqual(short.admissible);
    expect(long.affordable).toEqual(short.affordable);
  });
});

describe('the floor is hold-blind', () => {
  it('is byte-identical however much of the balance is reserved', () => {
    const unheld = getTurnOptions(fundingOf(30_000_000n), BASIS, selectionOf(['vendor/ladder']), {
      models: [LADDER],
      nowMs: NOW_MS,
    });
    const held = getTurnOptions(
      fundingOf(1_000_000n, 29_000_000n),
      BASIS,
      selectionOf(['vendor/ladder']),
      { models: [LADDER], nowMs: NOW_MS }
    );
    expect(held.affordable).toEqual(unheld.affordable);
    expect(held.admissible).not.toEqual(unheld.admissible);
  });
});

describe('the floor does react to discrete selections', () => {
  it('changes when a dimension is pinned', () => {
    const open = getTurnOptions(fundingOf(20_000_000n), BASIS, selectionOf(['vendor/ladder']), {
      models: [LADDER],
      nowMs: NOW_MS,
    });
    const pinned = getTurnOptions(
      fundingOf(20_000_000n),
      BASIS,
      selectionOf(['vendor/ladder'], { pinned: { effort: 'high' } }),
      { models: [LADDER], nowMs: NOW_MS }
    );
    expect(pinned.affordable).not.toEqual(open.affordable);
  });

  it('changes when a sibling is added', () => {
    const solo = getTurnOptions(fundingOf(20_000_000n), BASIS, selectionOf(['vendor/ladder']), {
      models: [LADDER, PLAIN],
      nowMs: NOW_MS,
    });
    const pair = getTurnOptions(
      fundingOf(20_000_000n),
      BASIS,
      selectionOf(['vendor/ladder', 'vendor/plain']),
      { models: [LADDER, PLAIN], nowMs: NOW_MS }
    );
    expect(pair.affordable).not.toEqual(solo.affordable);
  });

  it('changes when the modality changes', () => {
    const text = getTurnOptions(fundingOf(20_000_000n), BASIS, selectionOf(['vendor/plain']), {
      models: [PLAIN],
      nowMs: NOW_MS,
    });
    const image = getTurnOptions(
      fundingOf(20_000_000n),
      BASIS,
      selectionOf(['vendor/plain'], { modality: 'image' }),
      { models: [PLAIN], nowMs: NOW_MS }
    );
    expect(image.affordable).not.toEqual(text.affordable);
  });
});

describe('the inverted output-storage ratios', () => {
  it('prices a paid turn at 4 input chars per token and 2 output chars per token', () => {
    const options = getTurnOptions(
      fundingOf(1_000_000_000n, 0n, 'paid'),
      BASIS,
      selectionOf(['vendor/plain']),
      { models: [PLAIN], nowMs: NOW_MS }
    );
    // 250 input tokens x 1,000 + 8,000 x (2,000 + 600) + 300,000 input storage.
    expect(options.holdNanoUsd).toBe(21_350_000n);
  });

  it('prices a free turn at 2 input chars per token and 4 output chars per token', () => {
    const options = getTurnOptions(
      fundingOf(1_000_000_000n, 0n, 'free'),
      BASIS,
      selectionOf(['vendor/plain']),
      { models: [PLAIN], nowMs: NOW_MS }
    );
    // 500 input tokens x 1,000 + 8,000 x (2,000 + 1,200) + 300,000 input storage.
    expect(options.holdNanoUsd).toBe(26_400_000n);
  });

  it('rounds the input division up, against the user', () => {
    const odd = getTurnOptions(
      fundingOf(1_000_000_000n),
      { ...BASIS, inputChars: BASIS.inputChars + 1 },
      selectionOf(['vendor/plain']),
      { models: [PLAIN], nowMs: NOW_MS }
    );
    // One more character buys a whole extra input token, plus its own storage.
    expect(odd.holdNanoUsd).toBe(21_350_000n + 1000n + 300n);
  });
});

describe('a trial turn never persists', () => {
  it('carries no storage anywhere in its hold', () => {
    const options = getTurnOptions(
      fundingOf(1_000_000_000n, 0n, 'trial'),
      BASIS,
      selectionOf(['vendor/plain']),
      { models: [PLAIN], nowMs: NOW_MS }
    );
    // 500 input tokens x 1,000 + 8,000 x 2,000, and nothing else.
    expect(options.holdNanoUsd).toBe(16_500_000n);
  });
});

describe('cache reads', () => {
  it('are not projected into the money layer at all, so nothing can price them cheaply', () => {
    const rates = ratesFromPricing({
      inputPerToken: nanoUSD(1000n),
      outputPerToken: nanoUSD(2000n),
      cachedInputPerToken: nanoUSD(1n),
    });
    expect(rates).toEqual({ inputPerToken: 1000n, outputPerToken: 2000n });
  });

  it('price at the full input rate in the produced hold', () => {
    const rates = ratesFromPricing({
      inputPerToken: nanoUSD(1000n),
      outputPerToken: nanoUSD(2000n),
      cachedInputPerToken: nanoUSD(1n),
    });
    const cached: PriceableModel = {
      ...PLAIN,
      inputRateNanoUsd: nanoUSD(rates.inputPerToken ?? 0n),
      outputRateNanoUsd: nanoUSD(rates.outputPerToken ?? 0n),
    };
    const options = getTurnOptions(
      fundingOf(1_000_000_000n),
      BASIS,
      selectionOf(['vendor/plain']),
      { models: [cached], nowMs: NOW_MS }
    );
    // 250 input tokens at the FULL 1,000-nano rate, not the 1-nano cached rate.
    expect(options.holdNanoUsd).toBe(21_350_000n);
  });
});

describe('web search', () => {
  it('reserves 10 calls x $0.005 per model, billable, on a three-model turn', () => {
    const models: readonly PriceableModel[] = [
      PLAIN,
      { ...PLAIN, modelId: modelId('vendor/plain-b') },
      { ...PLAIN, modelId: modelId('vendor/plain-c') },
    ];
    const withoutSearch = getTurnOptions(
      fundingOf(10_000_000_000n),
      BASIS,
      selectionOf(['vendor/plain', 'vendor/plain-b', 'vendor/plain-c']),
      { models: models, nowMs: NOW_MS }
    );
    const withSearch = getTurnOptions(
      fundingOf(10_000_000_000n),
      BASIS,
      selectionOf(['vendor/plain', 'vendor/plain-b', 'vendor/plain-c'], { webSearch: true }),
      { models: models, nowMs: NOW_MS }
    );
    expect((withSearch.holdNanoUsd ?? 0n) - (withoutSearch.holdNanoUsd ?? 0n)).toBe(172_500_000n);
  });
});
