import { describe, expect, it } from 'vitest';
import { nanoUSD } from '@hushbox/shared';
import {
  TRIAL_MESSAGE_COST_CAP_NANO_USD,
  trialEligibility,
  trialMessageBaseNanoUsd,
  trialPriceThresholdNanoUsd,
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

  it('treats a missing per-token rate as zero when ranking the combined price', () => {
    // Only inputPerToken is priced; the absent outputPerToken counts as zero, so
    // the model stays cheap and below-quartile — eligible.
    const target = model({
      pricing: { inputPerToken: nanoUSD(5n) } as Pricing,
      releasedAt: OLD_RELEASE,
    });
    const catalog = [target, ...priceSpread([1000n, 2000n, 3000n])];
    expect(trialEligibility(target, catalog, NOW_MS)).toEqual({ eligible: true });
  });
});

describe('trialPriceThresholdNanoUsd', () => {
  it('returns the value at floor(len * 0.75) of the sorted combined prices', () => {
    // [10,20,30,100] sorted; floor(4 * 0.75) = index 3 => 100.
    const catalog = priceSpread([100n, 10n, 30n, 20n]);
    expect(trialPriceThresholdNanoUsd(catalog)).toBe(100n);
  });

  it('ignores non-text models when computing the threshold', () => {
    const textModels = priceSpread([10n, 20n, 30n, 40n]);
    const image = model({
      id: 'img',
      outputs: ['image'] as Modality[],
      pricing: pricing(999n, 0n),
    });
    // floor(4 * 0.75) = index 3 => 40 (the image's 999 is excluded).
    expect(trialPriceThresholdNanoUsd([...textModels, image])).toBe(40n);
  });

  it('has no threshold for an empty text catalog', () => {
    expect(trialPriceThresholdNanoUsd([])).toBeUndefined();
  });
});

describe('trialMessageBaseNanoUsd', () => {
  it('prices the actual prompt on the minimum basis (2000 output tokens), not the context window', () => {
    // prompt 10 chars -> ceil(10 / 2) = 5 input tokens.
    // base = 5 * 1000 + 2000 * 1000 = 2,005,000 — independent of the 1,000,000 context window.
    const target = model({ pricing: pricing(1000n, 1000n), limits: { contextLength: 1_000_000 } });
    const result = trialMessageBaseNanoUsd(target, '0123456789');
    expect(result.isOk() && result.value).toBe(2_005_000n);
  });

  it('exceeds the 1¢ cap for a long prompt on a mid-price model', () => {
    // 24000 chars -> 12000 input tokens; base = 12000*1000 + 2000*1000 = 14,000,000 > cap.
    const target = model({ pricing: pricing(1000n, 1000n) });
    const result = trialMessageBaseNanoUsd(target, 'x'.repeat(24_000));
    expect(result.isOk() && result.value > TRIAL_MESSAGE_COST_CAP_NANO_USD).toBe(true);
  });

  it('stays within the 1¢ cap for a short prompt on a mid-price model', () => {
    const target = model({ pricing: pricing(1000n, 1000n) });
    const result = trialMessageBaseNanoUsd(target, 'hello');
    expect(result.isOk() && result.value <= TRIAL_MESSAGE_COST_CAP_NANO_USD).toBe(true);
  });
});
