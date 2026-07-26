import { describe, expect, it } from 'vitest';

import { MINIMUM_OUTPUT_TOKENS } from '../constants.js';
import { affordability, evaluateManifest, reservationCeiling } from './reducers.js';
import type { Manifest } from './types.js';

// All rates are BILLABLE (fees baked at catalog ingestion) — the reducers are
// pure sums over provider and storage subtotals and never apply fee math.
const baseManifest: Manifest = {
  items: [
    { label: 'text-input-tokens', fixedNano: 500n, kind: 'provider' },
    { label: 'input-storage', fixedNano: 300_000n, kind: 'storage' },
    { label: 'text-output-tokens', variableOutputRateNano: 15n, kind: 'provider' },
    { label: 'output-storage', variableOutputRateNano: 1200n, kind: 'storage' },
  ],
};

describe('evaluateManifest', () => {
  it('folds only the provider line items under the provider-only scope', () => {
    // fixed = 500 (text-input); variable = 15 (text-output); storage excluded.
    expect(evaluateManifest(baseManifest, 1000n, { scope: 'provider-only' })).toBe(
      500n + 1000n * 15n
    );
  });

  it('folds every line item (storage included) under the all-in scope', () => {
    // fixed = 500 + 300000; variable = 15 + 1200.
    expect(evaluateManifest(baseManifest, 1000n, { scope: 'all-in' })).toBe(
      300_500n + 1000n * 1215n
    );
  });
});

describe('reservationCeiling', () => {
  it('sums fixed + ceiling×variable across provider and storage items with no fee math', () => {
    const total = reservationCeiling(baseManifest, {
      outputTokenCeiling: 1000n,
      fanOutWidth: 1,
      maxSteps: 1,
      maxIterations: 1,
    });
    // provider subtotal = 500 + 1000×15 = 15_500 (already billable)
    // storage subtotal = 300_000 + 1000×1200 = 1_500_000
    expect(total).toBe(15_500n + 1_500_000n);
  });

  it('multiplies the per-node ceiling by width × steps × iterations', () => {
    const total = reservationCeiling(baseManifest, {
      outputTokenCeiling: 1000n,
      fanOutWidth: 2,
      maxSteps: 3,
      maxIterations: 1,
    });
    expect(total).toBe((15_500n + 1_500_000n) * 6n);
  });

  it('reserves at least the all-in bill for every output count up to the ceiling', () => {
    // The over-reserve invariant: the reservation is ≥ what settlement could
    // charge for the same manifest at any actual output ≤ the declared ceiling
    // (settlement charges billable amounts; the manifest is already billable).
    const ceiling = 1000n;
    const reserved = reservationCeiling(baseManifest, {
      outputTokenCeiling: ceiling,
      fanOutWidth: 1,
      maxSteps: 1,
      maxIterations: 1,
    });
    for (const actualOutput of [0n, 1n, 500n, 999n, ceiling]) {
      const billable = evaluateManifest(baseManifest, actualOutput, { scope: 'all-in' });
      expect(reserved >= billable).toBe(true);
    }
  });

  it('rejects a non-positive or non-integer multiplier', () => {
    const ceiling = { outputTokenCeiling: 1000n, fanOutWidth: 1, maxSteps: 1, maxIterations: 1 };
    expect(() => reservationCeiling(baseManifest, { ...ceiling, fanOutWidth: 0 })).toThrow(
      RangeError
    );
    expect(() => reservationCeiling(baseManifest, { ...ceiling, maxSteps: 1.5 })).toThrow(
      RangeError
    );
    expect(() => reservationCeiling(baseManifest, { ...ceiling, maxIterations: -1 })).toThrow(
      RangeError
    );
  });

  it('rejects a negative output-token ceiling', () => {
    expect(() =>
      reservationCeiling(baseManifest, {
        outputTokenCeiling: -1n,
        fanOutWidth: 1,
        maxSteps: 1,
        maxIterations: 1,
      })
    ).toThrow(RangeError);
  });
});

describe('affordability', () => {
  // totalFixed = 500 + 300000 = 300500
  // effectiveVarRate = 15 + 1200 = 1215
  // minCost = 300500 + 1000×1215 = 1_515_500
  const minCost = 300_500n + BigInt(MINIMUM_OUTPUT_TOKENS) * 1215n;

  it('reports the minimum cost gated on MINIMUM_OUTPUT_TOKENS', () => {
    const result = affordability(baseManifest, 0n);
    expect(result.minCostNano).toBe(minCost);
  });

  it('can send at exactly the minimum cost, yielding MINIMUM_OUTPUT_TOKENS', () => {
    const result = affordability(baseManifest, minCost);
    expect(result.canSend).toBe(true);
    expect(result.maxOutputTokens).toBe(BigInt(MINIMUM_OUTPUT_TOKENS));
    expect(result.denialReason).toBeUndefined();
  });

  it('denies one nano below the minimum cost', () => {
    const result = affordability(baseManifest, minCost - 1n);
    expect(result.canSend).toBe(false);
    expect(result.maxOutputTokens).toBe(0n);
    expect(result.denialReason).toBe('insufficient_balance');
  });

  it('solves max output tokens as floor((balance − fixed)/variableRate)', () => {
    const balance = 300_500n + 5000n * 1215n;
    const result = affordability(baseManifest, balance);
    expect(result.maxOutputTokens).toBe(5000n);
  });

  it('floors a partial token that the balance cannot fully cover', () => {
    // 4999 tokens' worth + a fractional remainder that must floor down.
    const balance = 300_500n + 5000n * 1215n - 1n;
    const result = affordability(baseManifest, balance);
    expect(result.maxOutputTokens).toBe(4999n);
  });

  it('denies a zero balance', () => {
    const result = affordability(baseManifest, 0n);
    expect(result.canSend).toBe(false);
    expect(result.maxOutputTokens).toBe(0n);
    expect(result.denialReason).toBe('insufficient_balance');
  });

  it('denies a negative balance', () => {
    const result = affordability(baseManifest, -1_000_000n);
    expect(result.canSend).toBe(false);
    expect(result.maxOutputTokens).toBe(0n);
  });

  it('fails closed on a manifest with no variable output rate', () => {
    const manifest: Manifest = {
      items: [{ label: 'text-input-tokens', fixedNano: 500n, kind: 'provider' }],
    };
    expect(() => affordability(manifest, 1_000_000n)).toThrow(RangeError);
  });
});
