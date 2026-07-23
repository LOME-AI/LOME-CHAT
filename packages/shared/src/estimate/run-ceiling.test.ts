import { describe, expect, it } from 'vitest';
import { applyMarkup } from '../money.js';
import { nanoUSD } from '../nano-usd.js';
import {
  NO_STORAGE,
  callManifest,
  estimateRunCeilingNanoUsd,
  outputTokensOf,
  ratesFromPricing,
} from './run-ceiling.js';
import type { Pricing } from '../model-descriptor.js';

const TOKEN_PRICING: Pricing = {
  inputPerToken: nanoUSD(1n),
  outputPerToken: nanoUSD(2n),
};

const CEILING = { maxFanOutWidth: 1, maxSteps: 1, maxIterations: 1 } as const;

describe('ratesFromPricing', () => {
  it('maps every recognized rate key into the named-rate shape', () => {
    const rates = ratesFromPricing({
      inputPerToken: nanoUSD(1n),
      outputPerToken: nanoUSD(2n),
      perImage: nanoUSD(3n),
      perSecond: nanoUSD(4n),
      perSecondByResolution: { '1080p': nanoUSD(5n) },
    });
    expect(rates).toEqual({
      inputPerToken: 1n,
      outputPerToken: 2n,
      perImage: 3n,
      perSecond: 4n,
      perSecondByResolution: { '1080p': 5n },
    });
  });

  it('omits keys the pricing bag lacks so the core fails closed on the specific rate', () => {
    expect(ratesFromPricing({})).toEqual({});
  });
});

describe('outputTokensOf', () => {
  it('returns the output token count for a token usage', () => {
    expect(outputTokensOf({ kind: 'tokens', inputTokens: 10, outputTokens: 42 })).toBe(42n);
  });

  it('returns zero for a media usage (no token output leg)', () => {
    expect(outputTokensOf({ kind: 'media', rateKey: 'perImage', units: 1 })).toBe(0n);
  });
});

describe('callManifest', () => {
  it('prices a token call into a manifest', () => {
    const result = callManifest(
      TOKEN_PRICING,
      { kind: 'tokens', inputTokens: 100, outputTokens: 50 },
      NO_STORAGE
    );
    expect(result.ok).toBe(true);
  });

  it('fails closed on a non-integer token count', () => {
    const result = callManifest(
      TOKEN_PRICING,
      { kind: 'tokens', inputTokens: 1.5, outputTokens: 50 },
      NO_STORAGE
    );
    expect(result.ok).toBe(false);
  });

  it('fails closed on a negative output token count', () => {
    const result = callManifest(
      TOKEN_PRICING,
      { kind: 'tokens', inputTokens: 100, outputTokens: -1 },
      NO_STORAGE
    );
    expect(result.ok).toBe(false);
  });

  it('prices a media call into a manifest', () => {
    const result = callManifest(
      { perImage: nanoUSD(100n) },
      { kind: 'media', rateKey: 'perImage', units: 1 },
      NO_STORAGE
    );
    expect(result.ok).toBe(true);
  });

  it('fails closed on a media call missing its rate', () => {
    const result = callManifest({}, { kind: 'media', rateKey: 'perImage', units: 1 }, NO_STORAGE);
    expect(result.ok).toBe(false);
  });
});

describe('estimateRunCeilingNanoUsd', () => {
  it('prices a token ceiling at the marked-up provider cost across the declared worst case', () => {
    const result = estimateRunCeilingNanoUsd(
      TOKEN_PRICING,
      { kind: 'tokens', inputTokens: 1000, outputTokens: 1000 },
      CEILING
    );
    // provider base = 1000×1 + 1000×2 = 3000, marked up once.
    expect(result.ok && result.value).toBe(applyMarkup(3000n));
  });

  it('multiplies the ceiling by the declared width × steps × iterations', () => {
    const single = estimateRunCeilingNanoUsd(
      TOKEN_PRICING,
      { kind: 'tokens', inputTokens: 1000, outputTokens: 1000 },
      CEILING
    );
    const scaled = estimateRunCeilingNanoUsd(
      TOKEN_PRICING,
      { kind: 'tokens', inputTokens: 1000, outputTokens: 1000 },
      { maxFanOutWidth: 2, maxSteps: 3, maxIterations: 1 }
    );
    expect(single.ok).toBe(true);
    expect(scaled.ok).toBe(true);
    if (single.ok && scaled.ok) {
      expect(scaled.value).toBe(single.value * 6n);
    }
  });

  it('rejects a zero ceiling (a zero admission hold is a caller bug)', () => {
    // Priceable rates (both present) but zero-valued, so the manifest prices but
    // the ceiling reduces to 0 — the amount-is-zero fail-closed arm.
    const result = estimateRunCeilingNanoUsd(
      { inputPerToken: nanoUSD(0n), outputPerToken: nanoUSD(0n) },
      { kind: 'tokens', inputTokens: 1000, outputTokens: 1000 },
      CEILING
    );
    expect(result.ok).toBe(false);
  });

  it('rejects a non-positive-integer ceiling dimension on the fail-closed channel', () => {
    const result = estimateRunCeilingNanoUsd(
      TOKEN_PRICING,
      { kind: 'tokens', inputTokens: 1000, outputTokens: 1000 },
      { maxFanOutWidth: 0, maxSteps: 1, maxIterations: 1 }
    );
    expect(result.ok).toBe(false);
  });

  it('adds unmarked storage to the ceiling when a storage context is present', () => {
    const withoutStorage = estimateRunCeilingNanoUsd(
      TOKEN_PRICING,
      { kind: 'tokens', inputTokens: 1000, outputTokens: 1000 },
      CEILING
    );
    const withStorage = estimateRunCeilingNanoUsd(
      TOKEN_PRICING,
      { kind: 'tokens', inputTokens: 1000, outputTokens: 1000 },
      CEILING,
      { outputCharsPerToken: 4, mediaStorageBytes: 0 }
    );
    expect(withStorage.ok && withoutStorage.ok && withStorage.value > withoutStorage.value).toBe(
      true
    );
  });
});
