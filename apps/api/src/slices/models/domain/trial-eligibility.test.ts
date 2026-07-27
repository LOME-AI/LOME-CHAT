import { describe, expect, it } from 'vitest';
import { STORAGE_COST_PER_CHARACTER_NANO, buildTurnSystemPrompt, nanoUSD } from '@hushbox/shared';
import {
  estimateTokensForTier,
  outputCharsPerTokenForTier,
} from '@hushbox/shared/affordability/estimate/pre-adapters';
import { callBillableNanoUsd } from './estimate.js';
import {
  TRIAL_MESSAGE_COST_CAP_NANO_USD,
  isTextModel,
  trialEligibility,
  trialMessageBillableNanoUsd,
} from './trial-eligibility.js';
import type { Modality, ModelDescriptor, Pricing } from '@hushbox/shared';

// A fixed reference clock; recency is evaluated against it, not the wall clock.
const NOW_MS = 1_800_000_000_000;
// releasedAt (unix SECONDS) whose *1000 sits well before NOW - 182 days.
const OLD_RELEASE = 1_600_000_000;
// releasedAt whose *1000 sits within the last 182 days of NOW.
const RECENT_RELEASE = 1_790_000_000;

function pricing(inputPerToken: bigint, outputPerToken: bigint): Pricing {
  return { inputPerToken: nanoUSD(inputPerToken), outputPerToken: nanoUSD(outputPerToken) };
}

function model(overrides: Partial<ModelDescriptor> = {}): ModelDescriptor {
  return {
    id: 'test/model',
    provider: 'test',
    version: '1',
    inputs: ['text'] as Modality[],
    outputs: ['text'] as Modality[],
    parameters: {},
    behaviors: [],
    limits: { contextLength: 1_000_000 },
    pricing: pricing(1n, 1n),
    zdrReachable: true,
    releasedAt: OLD_RELEASE,
    fetchedAt: 0,
    ...overrides,
  };
}

/** A spread of cheap-to-expensive text models, target excluded, for the percentile. */
function priceSpread(prices: readonly bigint[]): ModelDescriptor[] {
  return prices.map((combined, index) =>
    model({ id: `spread/${String(index)}`, pricing: pricing(combined, 0n) })
  );
}

describe('isTextModel', () => {
  it('accepts a text-in text-out model', () => {
    expect(isTextModel(model({ inputs: ['text'], outputs: ['text'] }))).toBe(true);
  });

  it('accepts a multimodal-input text-out model (text plus image in, text out)', () => {
    expect(isTextModel(model({ inputs: ['text', 'image'] as Modality[], outputs: ['text'] }))).toBe(
      true
    );
  });

  it('rejects a multi-output model', () => {
    expect(isTextModel(model({ inputs: ['text'], outputs: ['text', 'image'] as Modality[] }))).toBe(
      false
    );
  });

  it('rejects a non-text single-output model', () => {
    expect(isTextModel(model({ inputs: ['text'], outputs: ['image'] as Modality[] }))).toBe(false);
  });
});

describe('trialEligibility', () => {
  it('blocks an image-output model as non-text', () => {
    const image = model({ outputs: ['image'] as Modality[] });
    expect(trialEligibility(image, [image], NOW_MS)).toEqual({
      eligible: false,
      reason: 'non-text',
    });
  });

  it('blocks a text-output model with no text input as non-text', () => {
    const imageInputOnly = model({ inputs: ['image'] as Modality[] });
    expect(trialEligibility(imageInputOnly, [imageInputOnly], NOW_MS)).toEqual({
      eligible: false,
      reason: 'non-text',
    });
  });

  it('blocks a text-plus-media-output model as non-text', () => {
    const textPlusImage = model({ outputs: ['text', 'image'] as Modality[] });
    expect(trialEligibility(textPlusImage, [textPlusImage], NOW_MS)).toEqual({
      eligible: false,
      reason: 'non-text',
    });
  });

  it('allows a multimodal-input, text-only-output model (text input present)', () => {
    const target = model({
      inputs: ['text', 'image'] as Modality[],
      pricing: pricing(1n, 1n),
      releasedAt: OLD_RELEASE,
    });
    const catalog = [target, ...priceSpread([1000n, 2000n, 3000n])];
    expect(trialEligibility(target, catalog, NOW_MS)).toEqual({ eligible: true });
  });

  it('marks a top-quartile-priced text model premium', () => {
    // Spread combined prices 10,20,30 with the target at 100 (the top).
    const target = model({ id: 'test/expensive', pricing: pricing(100n, 0n) });
    const catalog = [...priceSpread([10n, 20n, 30n]), target];
    expect(trialEligibility(target, catalog, NOW_MS)).toEqual({
      eligible: false,
      reason: 'premium',
    });
  });

  it('marks a recently released cheap text model premium', () => {
    const target = model({ pricing: pricing(1n, 1n), releasedAt: RECENT_RELEASE });
    // Sits alongside pricier models so the percentile leg does NOT fire — only recency.
    const catalog = [target, ...priceSpread([1000n, 2000n, 3000n])];
    expect(trialEligibility(target, catalog, NOW_MS)).toEqual({
      eligible: false,
      reason: 'premium',
    });
  });

  it('marks a per-token-expensive text model premium via minimal-exchange affordability', () => {
    // outputPerToken alone drives a minimal exchange (2000 output tokens) past 1¢.
    // 2000 * 6000 = 12,000,000 nano > 10,000,000 cap.
    const target = model({ pricing: pricing(0n, 6000n) });
    const catalog = [target, ...priceSpread([6000n, 6000n, 6000n])];
    expect(trialEligibility(target, catalog, NOW_MS)).toEqual({
      eligible: false,
      reason: 'premium',
    });
  });

  it('marks a cheap, old, below-quartile text model eligible', () => {
    const target = model({ pricing: pricing(1n, 1n), releasedAt: OLD_RELEASE });
    const catalog = [target, ...priceSpread([1000n, 2000n, 3000n])];
    expect(trialEligibility(target, catalog, NOW_MS)).toEqual({ eligible: true });
  });

  it('refuses a text model missing the output per-token rate as premium (would error mid-send)', () => {
    // Only inputPerToken is priced; pricing a token exchange requires both rates,
    // so the send would error — refuse at the gate as premium instead.
    const target = model({
      pricing: { inputPerToken: nanoUSD(5n) } as Pricing,
      releasedAt: OLD_RELEASE,
    });
    const catalog = [target, ...priceSpread([1000n, 2000n, 3000n])];
    expect(trialEligibility(target, catalog, NOW_MS)).toEqual({
      eligible: false,
      reason: 'premium',
    });
  });

  it('refuses a text model priced only on cached input as premium (not a send error)', () => {
    const target = model({
      pricing: { cachedInputPerToken: nanoUSD(1n) } as Pricing,
      releasedAt: OLD_RELEASE,
    });
    const catalog = [target, ...priceSpread([1000n, 2000n, 3000n])];
    expect(trialEligibility(target, catalog, NOW_MS)).toEqual({
      eligible: false,
      reason: 'premium',
    });
  });

  it('does not mark the sole text model premium via a degenerate small-sample percentile', () => {
    // A single-model catalog would otherwise price the model premium against
    // itself (floor(1 * 0.75) = index 0). The min-sample guard skips the leg.
    const target = model({ pricing: pricing(1n, 1n), releasedAt: OLD_RELEASE });
    expect(trialEligibility(target, [target], NOW_MS)).toEqual({ eligible: true });
  });
});

describe('the premium price boundary over the exposed catalog', () => {
  // The percentile itself is the money layer's (`premiumPriceThresholdNanoUsd`);
  // what this file owns is WHICH models form the distribution.
  it('marks the model at floor(len * 0.75) of the combined prices premium', () => {
    const catalog = priceSpread([100n, 10n, 30n, 20n]);
    const atThreshold = catalog.find((entry) => entry.pricing['inputPerToken'] === nanoUSD(100n));
    const below = catalog.find((entry) => entry.pricing['inputPerToken'] === nanoUSD(30n));
    expect(trialEligibility(atThreshold!, catalog, NOW_MS)).toEqual({
      eligible: false,
      reason: 'premium',
    });
    expect(trialEligibility(below!, catalog, NOW_MS)).toEqual({ eligible: true });
  });

  it('ignores non-text models when forming the distribution', () => {
    const textModels = priceSpread([10n, 20n, 30n, 40n]);
    const image = model({
      id: 'img',
      outputs: ['image'] as Modality[],
      pricing: pricing(999n, 0n),
    });
    // The image's 999 would push the threshold up and let the 40 model through.
    const dearest = textModels.find((entry) => entry.pricing['inputPerToken'] === nanoUSD(40n));
    expect(trialEligibility(dearest!, [...textModels, image], NOW_MS)).toEqual({
      eligible: false,
      reason: 'premium',
    });
  });
});

describe('trialMessageBillableNanoUsd', () => {
  it('prices the actual prompt on the minimum basis (2000 output tokens), not the context window', () => {
    // prompt 10 chars -> 10 input chars -> ceil(10 / 2) = 5 input tokens; 2000 output tokens.
    // provider = 5 * 1000 + 2000 * 1000 = 2,005,000.
    // storage  = 10 * 300 (input chars) + 2000 * 4 * 300 (output, trial ratio) = 2,403,000.
    // canonical (with-storage) total = 4,408,000 — independent of the 1,000,000 context window.
    const target = model({ pricing: pricing(1000n, 1000n), limits: { contextLength: 1_000_000 } });
    const result = trialMessageBillableNanoUsd(target, '0123456789', []);
    expect(result.isOk() && result.value).toBe(4_408_000n);
  });

  it('exceeds the 1¢ cap for a long prompt on a mid-price model', () => {
    // 24000 chars -> 12000 input tokens; base = 12000*1000 + 2000*1000 = 14,000,000 > cap.
    const target = model({ pricing: pricing(1000n, 1000n) });
    const result = trialMessageBillableNanoUsd(target, 'x'.repeat(24_000), []);
    expect(result.isOk() && result.value > TRIAL_MESSAGE_COST_CAP_NANO_USD).toBe(true);
  });

  it('stays within the 1¢ cap for a short prompt on a mid-price model', () => {
    const target = model({ pricing: pricing(1000n, 1000n) });
    const result = trialMessageBillableNanoUsd(target, 'hello', []);
    expect(result.isOk() && result.value <= TRIAL_MESSAGE_COST_CAP_NANO_USD).toBe(true);
  });

  it('prices the summed history content plus the prompt', () => {
    // history 4 + 6 chars, prompt 10 chars -> 20 input chars -> ceil(20 / 2) = 10 input tokens.
    // provider = 10 * 1000 + 2000 * 1000 = 2,010,000.
    // storage  = 20 * 300 + 2000 * 4 * 300 = 2,406,000.
    // canonical (with-storage) total = 4,416,000.
    const target = model({ pricing: pricing(1000n, 1000n) });
    const result = trialMessageBillableNanoUsd(target, '0123456789', [
      { role: 'user', content: 'abcd' },
      { role: 'assistant', content: 'efghij' },
    ]);
    expect(result.isOk() && result.value).toBe(4_416_000n);
  });

  it('derives input tokens from the shared estimateTokensForTier helper', () => {
    const prompt = '0123456789';
    const history = [
      { role: 'user' as const, content: 'abcd' },
      { role: 'assistant' as const, content: 'efghij' },
    ];
    const totalChars = prompt.length + history.reduce((sum, m) => sum + m.content.length, 0);
    const expectedInputTokens = estimateTokensForTier('trial', totalChars);
    // provider = inputTokens * inputRate + 2000 output tokens * outputRate;
    // storage  = totalChars * charRate (input) + 2000 * outputCharsPerToken(trial) * charRate.
    const providerBase = BigInt(expectedInputTokens) * 1000n + 2000n * 1000n;
    const storageBase =
      BigInt(totalChars) * STORAGE_COST_PER_CHARACTER_NANO +
      2000n * BigInt(outputCharsPerTokenForTier('trial')) * STORAGE_COST_PER_CHARACTER_NANO;
    const target = model({ pricing: pricing(1000n, 1000n) });
    const result = trialMessageBillableNanoUsd(target, prompt, history);
    expect(result.isOk() && result.value).toBe(providerBase + storageBase);
  });

  it('surfaces a model missing a per-token rate as a validation error (never a silent price)', () => {
    // priceRequest fails closed when the output rate is absent; the send cannot
    // be priced, so the trial gate refuses it rather than under-charging.
    const target = model({ pricing: { inputPerToken: nanoUSD(5n) } as Pricing });
    const result = trialMessageBillableNanoUsd(target, 'hi', []);
    expect(result.isErr()).toBe(true);
    expect(result.isErr() && result.error.code).toBe('validation');
  });

  it('exceeds the 1¢ cap when a long history inflates a short prompt', () => {
    // 24000 history chars + 5 prompt chars -> 12003 input tokens; over the cap.
    const target = model({ pricing: pricing(1000n, 1000n) });
    const result = trialMessageBillableNanoUsd(target, 'hello', [
      { role: 'user', content: 'x'.repeat(12_000) },
      { role: 'assistant', content: 'y'.repeat(12_000) },
    ]);
    expect(result.isOk() && result.value > TRIAL_MESSAGE_COST_CAP_NANO_USD).toBe(true);
  });
});

/**
 * The per-message gate must stay strictly stricter than the floor the compiled
 * trial turn prices, or an over-cap turn reaches the provider. The gate does not
 * price the server's own system prompt (1,609 characters, 805 trial input tokens)
 * while the turn does, so what covers that unpriced input leg is the gate's
 * surplus: 1,000 extra output tokens plus the pass-through storage of the send.
 *
 * The surplus is finite, so domination is a property of the RATE SHAPE, not a
 * theorem. Measured here in both directions: it holds across the whole shape band
 * the live catalog occupies (176 of 176 exposed text models price output at or
 * above input), and it fails past a measured inversion — which is why §Trial
 * Usage's storage-free reading cannot be applied to this gate until the gate
 * prices the same input the turn does.
 */
describe('the per-message gate dominates the compiled turn floor', () => {
  /** The exact base system prompt the send carries but this gate never counts. */
  const SYSTEM_PROMPT_CHARS = buildTurnSystemPrompt({
    now: new Date('2026-07-26T00:00:00Z'),
  }).length;
  const PROMPT = 'x'.repeat(400);

  /** The unstamped turn's own floor: the whole input the send carries, at a
   * minimum answer, provider-only — trial turns persist nothing. */
  function compiledTurnFloorNanoUsd(target: ModelDescriptor): bigint {
    return callBillableNanoUsd(target.pricing, {
      kind: 'tokens',
      inputTokens: estimateTokensForTier('trial', SYSTEM_PROMPT_CHARS + PROMPT.length),
      outputTokens: 1000,
    })._unsafeUnwrap();
  }

  /** The gate with its storage line items removed — the strip §Trial Usage asks
   * for, priced here rather than shipped. */
  function gateWithoutStorageNanoUsd(target: ModelDescriptor): bigint {
    return callBillableNanoUsd(target.pricing, {
      kind: 'tokens',
      inputTokens: estimateTokensForTier('trial', PROMPT.length),
      outputTokens: 2000,
    })._unsafeUnwrap();
  }

  function gateNanoUsd(target: ModelDescriptor): bigint {
    return trialMessageBillableNanoUsd(target, PROMPT, [])._unsafeUnwrap();
  }

  const LIVE_SHAPES: readonly (readonly [string, bigint, bigint])[] = [
    ['output far dearer', 100n, 400n],
    ['output slightly dearer', 100n, 200n],
    ['flat', 100n, 100n],
  ];

  it.each(LIVE_SHAPES)('holds as shipped for a %s shape', (_label, input, output) => {
    const target = model({ pricing: pricing(input, output) });
    expect(gateNanoUsd(target)).toBeGreaterThan(compiledTurnFloorNanoUsd(target));
  });

  it.each(LIVE_SHAPES)('holds WITHOUT storage for a %s shape', (_label, input, output) => {
    const target = model({ pricing: pricing(input, output) });
    expect(gateWithoutStorageNanoUsd(target)).toBeGreaterThan(compiledTurnFloorNanoUsd(target));
  });

  it('fails as shipped once input is ~32.5× output — a pre-existing gap, not a new one', () => {
    // The gate carries 200 prompt tokens where the turn carries 1,005, so its
    // surplus is 1,000 × output + storage(400 input chars + 2,000 output tokens at
    // the trial ratio) less the 805 unpriced system-prompt tokens:
    // 2,620,000 − 805 × input, which turns negative at input 3,255.
    const inside = model({ pricing: pricing(3254n, 100n) });
    const outside = model({ pricing: pricing(3255n, 100n) });
    expect(gateNanoUsd(inside)).toBeGreaterThan(compiledTurnFloorNanoUsd(inside));
    expect(gateNanoUsd(outside)).toBeLessThan(compiledTurnFloorNanoUsd(outside));
  });

  it('fails WITHOUT storage as soon as input passes ~1.25× output — a 26× wider band', () => {
    // With no storage the surplus is 1,000 × output alone, so the boundary falls
    // from input 3,256 to input 125 at output 100: an inverted shape the shipped
    // gate refuses would be admitted, which is why the strip is not applied here.
    const inverted = model({ pricing: pricing(125n, 100n) });
    expect(gateNanoUsd(inverted)).toBeGreaterThan(compiledTurnFloorNanoUsd(inverted));
    expect(gateWithoutStorageNanoUsd(inverted)).toBeLessThan(compiledTurnFloorNanoUsd(inverted));
  });

  it('measures the escape for a far-inverted shape by amount', () => {
    const inverted = model({ pricing: pricing(4000n, 100n) });
    expect(compiledTurnFloorNanoUsd(inverted) - gateWithoutStorageNanoUsd(inverted)).toBe(
      805n * 4000n - 1000n * 100n
    );
  });
});
