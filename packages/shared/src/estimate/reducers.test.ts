import { describe, expect, it } from 'vitest';

import { MINIMUM_OUTPUT_TOKENS } from '../constants.js';
import { applyMarkup } from '../money.js';
import { affordability, evaluateManifest, reservationCeiling } from './reducers.js';
import type { Manifest } from './types.js';

// Base manifest = single model (input 5/tok, output 15/tok), 100 input tokens,
// 1000 prompt chars, output storage 4 chars/tok × 300 nano/char × 1 model.
const baseManifest: Manifest = {
  items: [
    { label: 'text-input-tokens', fixedNano: 500n, marksUp: true },
    { label: 'input-storage', fixedNano: 300_000n, marksUp: false },
    { label: 'text-output-tokens', variableOutputRateNano: 15n, marksUp: true },
    { label: 'output-storage', variableOutputRateNano: 1200n, marksUp: false },
  ],
};

describe('evaluateManifest', () => {
  it('folds only the marked-up (provider) line items when marksUpOnly is true', () => {
    // fixed = 500 (text-input); variable = 15 (text-output); storage excluded.
    expect(evaluateManifest(baseManifest, 1000n, { marksUpOnly: true })).toBe(500n + 1000n * 15n);
  });

  it('folds every line item raw (storage included) when marksUpOnly is false', () => {
    // fixed = 500 + 300000; variable = 15 + 1200; no markup applied either way.
    expect(evaluateManifest(baseManifest, 1000n, { marksUpOnly: false })).toBe(
      300_500n + 1000n * 1215n
    );
  });

  it('never applies markup — both folds return the pre-markup base', () => {
    const markedUpOnly = evaluateManifest(baseManifest, 0n, { marksUpOnly: true });
    expect(markedUpOnly).toBe(500n);
    expect(applyMarkup(markedUpOnly)).not.toBe(markedUpOnly);
  });
});

describe('reservationCeiling', () => {
  it('sums fixed + ceiling×variable, marks up model cost once, leaves storage raw', () => {
    const total = reservationCeiling(baseManifest, {
      outputTokenCeiling: 1000n,
      fanOutWidth: 1,
      maxSteps: 1,
      maxIterations: 1,
    });
    // marked-up subtotal = 500 + 1000×15 = 15500 -> applyMarkup = 17825
    // raw subtotal = 300000 + 1000×1200 = 1_500_000 (never marked up)
    expect(total).toBe(17_825n + 1_500_000n);
  });

  it('multiplies the per-node ceiling by width × steps × iterations', () => {
    const total = reservationCeiling(baseManifest, {
      outputTokenCeiling: 1000n,
      fanOutWidth: 2,
      maxSteps: 3,
      maxIterations: 1,
    });
    expect(total).toBe((17_825n + 1_500_000n) * 6n);
  });

  it('applies the markup ONCE to the summed marked-up subtotal, not per item', () => {
    const manifest: Manifest = {
      items: [
        { label: 'a', fixedNano: 3n, marksUp: true },
        { label: 'b', fixedNano: 3n, marksUp: true },
      ],
    };
    const total = reservationCeiling(manifest, {
      outputTokenCeiling: 0n,
      fanOutWidth: 1,
      maxSteps: 1,
      maxIterations: 1,
    });
    // markup once on 6 -> round(6.9) = 7; per-item would be applyMarkup(3)*2 = 6
    expect(total).toBe(applyMarkup(6n));
    expect(total).toBe(7n);
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
  // totalFixed = applyMarkup(500) + 300000 = 575 + 300000 = 300575
  // effectiveVarRate = applyMarkup(15) + 1200 = 17 + 1200 = 1217
  // minCost = 300575 + 1000×1217 = 1_517_575
  const minCost = 300_575n + BigInt(MINIMUM_OUTPUT_TOKENS) * 1217n;

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
    const balance = 300_575n + 5000n * 1217n;
    const result = affordability(baseManifest, balance);
    expect(result.maxOutputTokens).toBe(5000n);
  });

  it('floors a partial token that the balance cannot fully cover', () => {
    // 4999 tokens' worth + a fractional remainder that must floor down.
    const balance = 300_575n + 5000n * 1217n - 1n;
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
      items: [{ label: 'text-input-tokens', fixedNano: 500n, marksUp: true }],
    };
    expect(() => affordability(manifest, 1_000_000n)).toThrow(RangeError);
  });
});
