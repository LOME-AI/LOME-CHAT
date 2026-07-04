import { describe, expect, it } from 'vitest';
import { nanoUSD } from '@hushbox/shared';
import { applyMarkup } from '../../billing/index.js';
import { createGenerationInfoClient } from '../adapters/generation-info-client.js';
import { estimateCallNanoUsd, estimateRunCeilingNanoUsd } from './estimate.js';
import type { Pricing } from '@hushbox/shared';
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

describe('estimate and true-up sources', () => {
  /** SYNTHETIC: the gateway's /v1/generation record, authored from its response schema. */
  function generationInfoBody(id: string, totalCost: number): unknown {
    return {
      data: {
        id,
        total_cost: totalCost,
        upstream_inference_cost: 0,
        usage: totalCost,
        created_at: '2026-06-11T00:00:00.000Z',
        model: 'openai/gpt-4o',
        is_byok: false,
        provider_name: 'openai',
        streamed: true,
        finish_reason: 'stop',
        latency: 320,
        generation_time: 900,
        native_tokens_prompt: 1000,
        native_tokens_completion: 200,
        native_tokens_reasoning: 0,
        native_tokens_cached: 0,
        native_tokens_cache_creation: 0,
        billable_web_search_calls: 0,
      },
    };
  }

  it('estimates from catalog rates while true-up reads the gateway generation cost', async () => {
    // The estimate's only inputs are catalog pricing and observed usage —
    // the gateway's authoritative cost (true-up's source, billing's flow)
    // arrives through the generation-info client and diverges freely.
    const estimate = estimateCallNanoUsd(TOKEN_PRICING, TOKEN_USAGE)._unsafeUnwrap();

    const client = createGenerationInfoClient({
      apiKey: 'test-key',
      fetch: () => Promise.resolve(Response.json(generationInfoBody('gen_src', 0.0021))),
    });
    const trueUpResult = await client.fetchGenerationInfo('gen_src');
    const trueUp = trueUpResult._unsafeUnwrap();

    expect(estimate).toBe(5_175_000n);
    expect(trueUp.totalCostUsd).toBe(0.0021); // 2_100_000 nano-USD base — not the estimate's number
  });
});
