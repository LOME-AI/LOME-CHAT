import { describe, expect, it } from 'vitest';
import { nanoUSD } from '@hushbox/shared';
import { applyMarkup } from '../../billing/index.js';
import {
  callBaseNanoUsd,
  estimateCallNanoUsd,
  estimateRunCeilingNanoUsd,
  priceUsageBaseNanoUsd,
} from './estimate.js';
import type { Pricing, Usage } from '@hushbox/shared';
import type { CallUsage, DeclaredCeiling } from './estimate.js';

const TOKEN_PRICING: Pricing = {
  inputPerToken: nanoUSD(2500n),
  outputPerToken: nanoUSD(10_000n),
};

const TOKEN_USAGE: CallUsage = { kind: 'tokens', inputTokens: 1000, outputTokens: 200 };

const CEILING: DeclaredCeiling = { maxFanOutWidth: 3, maxSteps: 4, maxIterations: 2 };

describe('estimateCallNanoUsd', () => {
  it('prices token usage from the catalog per-token rates with the markup applied', () => {
    const result = estimateCallNanoUsd(TOKEN_PRICING, TOKEN_USAGE);

    // 1000 × 2500 + 200 × 10000 = 4_500_000 base; billing's 15% markup lands once.
    expect(result._unsafeUnwrap()).toBe(applyMarkup(4_500_000n));
    expect(result._unsafeUnwrap()).toBe(5_175_000n);
  });

  it('prices media units from a flat catalog rate', () => {
    const result = estimateCallNanoUsd(
      { perSecond: nanoUSD(5_000_000n) },
      { kind: 'media', rateKey: 'perSecond', units: 8 }
    );

    expect(result._unsafeUnwrap()).toBe(applyMarkup(40_000_000n));
  });

  it('prices media units from a per-dimension pricing matrix', () => {
    const result = estimateCallNanoUsd(
      { perImage: { '1024x1024': nanoUSD(40_000_000n) } },
      { kind: 'media', rateKey: 'perImage', dimensionKey: '1024x1024', units: 2 }
    );

    expect(result._unsafeUnwrap()).toBe(applyMarkup(80_000_000n));
  });

  it('rejects token usage when a per-token rate is missing (never a silent zero)', () => {
    const result = estimateCallNanoUsd({ inputPerToken: nanoUSD(2500n) }, TOKEN_USAGE);

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('rejects negative token counts', () => {
    const result = estimateCallNanoUsd(TOKEN_PRICING, {
      kind: 'tokens',
      inputTokens: -1,
      outputTokens: 0,
    });

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('rejects fractional token counts', () => {
    const result = estimateCallNanoUsd(TOKEN_PRICING, {
      kind: 'tokens',
      inputTokens: 1.5,
      outputTokens: 0,
    });

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('rejects a media rate key absent from the catalog pricing', () => {
    const result = estimateCallNanoUsd({}, { kind: 'media', rateKey: 'perImage', units: 1 });

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('rejects a matrix rate addressed without a dimension key', () => {
    const result = estimateCallNanoUsd(
      { perImage: { '1024x1024': nanoUSD(40_000_000n) } },
      { kind: 'media', rateKey: 'perImage', units: 1 }
    );

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('rejects a dimension key absent from the pricing matrix', () => {
    const result = estimateCallNanoUsd(
      { perImage: { '1024x1024': nanoUSD(40_000_000n) } },
      { kind: 'media', rateKey: 'perImage', dimensionKey: '512x512', units: 1 }
    );

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('rejects a dimension key addressed at a flat rate', () => {
    const result = estimateCallNanoUsd(
      { perSecond: nanoUSD(5_000_000n) },
      { kind: 'media', rateKey: 'perSecond', dimensionKey: '720p', units: 1 }
    );

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('rejects non-positive media units', () => {
    const result = estimateCallNanoUsd(
      { perSecond: nanoUSD(5_000_000n) },
      { kind: 'media', rateKey: 'perSecond', units: 0 }
    );

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });
});

describe('estimateRunCeilingNanoUsd', () => {
  it('prices the declared ceiling: per-call base times width, steps, and iterations', () => {
    const result = estimateRunCeilingNanoUsd(TOKEN_PRICING, TOKEN_USAGE, CEILING);

    // 4_500_000 base × 3 × 4 × 2 = 108_000_000; markup applied once, on the total.
    expect(result._unsafeUnwrap()).toBe(applyMarkup(108_000_000n));
  });

  it('rejects a non-positive ceiling dimension', () => {
    const result = estimateRunCeilingNanoUsd(TOKEN_PRICING, TOKEN_USAGE, {
      maxFanOutWidth: 0,
      maxSteps: 1,
      maxIterations: 1,
    });

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('rejects a fractional ceiling dimension', () => {
    const result = estimateRunCeilingNanoUsd(TOKEN_PRICING, TOKEN_USAGE, {
      maxFanOutWidth: 1,
      maxSteps: 1.5,
      maxIterations: 1,
    });

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('rejects an all-zero usage ceiling instead of pricing a free admission', () => {
    const result = estimateRunCeilingNanoUsd(
      TOKEN_PRICING,
      { kind: 'tokens', inputTokens: 0, outputTokens: 0 },
      CEILING
    );

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('surfaces the per-call pricing error unchanged', () => {
    const result = estimateRunCeilingNanoUsd({}, TOKEN_USAGE, CEILING);

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });
});

describe('callBaseNanoUsd', () => {
  it('prices token usage as BASE, without the markup', () => {
    const base = callBaseNanoUsd(TOKEN_PRICING, TOKEN_USAGE);

    // 1000 × 2500 + 200 × 10000 = 4_500_000 base — no markup applied.
    expect(base._unsafeUnwrap()).toBe(4_500_000n);
  });

  it('prices media units as BASE, without the markup', () => {
    const base = callBaseNanoUsd(
      { perSecond: nanoUSD(5_000_000n) },
      { kind: 'media', rateKey: 'perSecond', units: 8 }
    );

    expect(base._unsafeUnwrap()).toBe(40_000_000n);
  });

  it('returns strictly less than the marked-up estimate, by exactly the markup', () => {
    const base = callBaseNanoUsd(TOKEN_PRICING, TOKEN_USAGE)._unsafeUnwrap();
    const marked = estimateCallNanoUsd(TOKEN_PRICING, TOKEN_USAGE)._unsafeUnwrap();

    expect(base).toBeLessThan(marked);
    expect(applyMarkup(base)).toBe(marked);
  });

  it('surfaces a missing per-token rate as a validation error', () => {
    const base = callBaseNanoUsd({ inputPerToken: nanoUSD(2500n) }, TOKEN_USAGE);

    expect(base._unsafeUnwrapErr().code).toBe('validation');
  });
});

describe('priceUsageBaseNanoUsd', () => {
  const USAGE: Usage = { inputTokens: 1000, outputTokens: 200 };

  it('prices observed usage as BASE, without the markup', () => {
    const base = priceUsageBaseNanoUsd(TOKEN_PRICING, USAGE);

    expect(base._unsafeUnwrap()).toBe(4_500_000n);
  });

  it('does not apply the markup — base is the marked-up amount divided out', () => {
    const base = priceUsageBaseNanoUsd(TOKEN_PRICING, USAGE)._unsafeUnwrap();
    const marked = estimateCallNanoUsd(TOKEN_PRICING, {
      kind: 'tokens',
      inputTokens: 1000,
      outputTokens: 200,
    })._unsafeUnwrap();

    expect(base).toBeLessThan(marked);
    expect(applyMarkup(base)).toBe(marked);
  });

  it('does not add reasoning tokens on top of the output leg (a subset already in outputTokens)', () => {
    const withReasoning = priceUsageBaseNanoUsd(TOKEN_PRICING, { ...USAGE, reasoningTokens: 50 });
    const withoutReasoning = priceUsageBaseNanoUsd(TOKEN_PRICING, USAGE);

    // outputTokens (200) already includes the 50 reasoning tokens, so the
    // output leg prices at 200 × 10000, never 250 × — 1000 × 2500 + 200 × 10000.
    expect(withReasoning._unsafeUnwrap()).toBe(4_500_000n);
    // Reporting the reasoning breakdown must not change the price.
    expect(withReasoning._unsafeUnwrap()).toBe(withoutReasoning._unsafeUnwrap());
  });

  it('ignores cached input tokens (a subset already counted at the full input rate)', () => {
    const base = priceUsageBaseNanoUsd(TOKEN_PRICING, { ...USAGE, cachedInputTokens: 400 });

    expect(base._unsafeUnwrap()).toBe(4_500_000n);
  });

  it('surfaces a missing per-token rate as a validation error', () => {
    const base = priceUsageBaseNanoUsd({ inputPerToken: nanoUSD(2500n) }, USAGE);

    expect(base._unsafeUnwrapErr().code).toBe('validation');
  });
});
