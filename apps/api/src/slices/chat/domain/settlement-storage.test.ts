import { describe, expect, it } from 'vitest';
import {
  MEDIA_STORAGE_COST_PER_BYTE_NANO,
  STORAGE_COST_PER_CHARACTER_NANO,
} from '../../billing/index.js';
import { serializeReasoningText } from '@hushbox/shared';
import { collectPersistableCharges, withStorageFees } from './settlement.js';
import type { SettlementCharge, SettlementRequest } from '@hushbox/shared';

/**
 * The additive storage fee attached at settlement: exact per-char/per-byte
 * rates, the shared user prompt counted ONCE per turn (only the primary
 * charge), the resent history never counted.
 */

function textCharge(key: string): SettlementCharge {
  return {
    key,
    modelId: 'm',
    providerName: 'p',
    modality: 'text',
    billableCostNanoUsd: 1000n,
    isEstimated: false,
  };
}

const CHAR = STORAGE_COST_PER_CHARACTER_NANO;
const BYTE = MEDIA_STORAGE_COST_PER_BYTE_NANO;

describe('withStorageFees', () => {
  it('charges prompt + response chars at the per-character rate for a text turn', () => {
    const request: SettlementRequest = {
      runKey: 'k',
      outputs: { answer: { kind: 'text', text: 'hello' } }, // 5 chars
      charges: [textCharge('answer')],
    };
    const [charge] = withStorageFees(request, 3); // prompt 3 chars
    expect(charge?.storageFeeNanoUsd).toBe(BigInt(3 + 5) * CHAR);
  });

  it('attributes the shared prompt storage ONCE across a multi-model turn', () => {
    const request: SettlementRequest = {
      runKey: 'k',
      outputs: {
        'model-a': { kind: 'text', text: 'aa' }, // 2 chars
        'model-b': { kind: 'text', text: 'bbbb' }, // 4 chars
      },
      charges: [textCharge('model-a'), textCharge('model-b')],
    };
    const promptChars = 10;
    const [a, b] = withStorageFees(request, promptChars);
    // Primary branch carries prompt + its own response; the second carries only
    // its own response — the prompt is stored once, never N times.
    expect(a?.storageFeeNanoUsd).toBe(BigInt(promptChars + 2) * CHAR);
    expect(b?.storageFeeNanoUsd).toBe(4n * CHAR);
    const totalPromptStorage =
      (a?.storageFeeNanoUsd ?? 0n) + (b?.storageFeeNanoUsd ?? 0n) - BigInt(2 + 4) * CHAR; // subtract the response storage
    expect(totalPromptStorage).toBe(BigInt(promptChars) * CHAR); // == single, not ×2
  });

  it('adds media byte storage at the per-byte rate on top of prompt storage', () => {
    const request: SettlementRequest = {
      runKey: 'k',
      outputs: {
        img: {
          kind: 'media',
          value: {
            ref: 'media/a/b/c',
            mimeType: 'image/png',
            modality: 'image',
            byteLength: 100,
            metadata: {},
          },
        },
      },
      charges: [{ ...textCharge('img'), modality: 'image' }],
    };
    const [charge] = withStorageFees(request, 7); // prompt 7 chars, no response text
    expect(charge?.storageFeeNanoUsd).toBe(7n * CHAR + 100n * BYTE);
  });

  it('counts only the new turn — a longer prompt argument, never resent history', () => {
    const request: SettlementRequest = {
      runKey: 'k',
      outputs: { answer: { kind: 'text', text: 'x' } },
      charges: [textCharge('answer')],
    };
    // The prompt-char argument is the NEW user message only; history never
    // reaches this function, so a caller passing only the new prompt length is
    // the whole contract.
    const [charge] = withStorageFees(request, 4);
    expect(charge?.storageFeeNanoUsd).toBe(BigInt(4 + 1) * CHAR);
  });

  it('counts the stored field as-is when the answer embeds reasoning (no special casing)', () => {
    // Same-field storage doctrine: reasoning persists inside the assistant
    // text, and settlement char-counts the stored field exactly — delimiters
    // and reasoning included, never re-parsed or discounted.
    const stored = serializeReasoningText('inner thoughts', 'the answer');
    const request: SettlementRequest = {
      runKey: 'k',
      outputs: { answer: { kind: 'text', text: stored } },
      charges: [textCharge('answer')],
    };
    const [charge] = withStorageFees(request, 2);
    expect(charge?.storageFeeNanoUsd).toBe(BigInt(2 + stored.length) * CHAR);
  });
});

describe('withStorageFees — a turn-level charge that persists nothing', () => {
  /**
   * A turn-level generation (the classifier) runs before the siblings and
   * carries no content of its own, so it is the run's FIRST charge. The shared
   * prompt fee still has to ride a charge that MINTED a content item, so the
   * whole fee lands on one item deterministically in both the debit and the
   * display, rather than on whichever item the run-level anchor happens to
   * resolve for a contentless charge.
   */
  it('lands the shared prompt fee on the first PERSISTED charge, not the first charge', () => {
    const request: SettlementRequest = {
      runKey: 'k',
      outputs: { 'model-a': { kind: 'text', text: 'aa' } }, // 2 chars
      charges: [textCharge('classify'), textCharge('model-a')],
    };
    const [classify, a] = withStorageFees(request, 10);
    expect(classify?.storageFeeNanoUsd).toBe(0n);
    expect(a?.storageFeeNanoUsd).toBe(BigInt(10 + 2) * CHAR);
  });

  it('still counts the shared prompt exactly once across the run', () => {
    const request: SettlementRequest = {
      runKey: 'k',
      outputs: {
        'model-a': { kind: 'text', text: 'aa' },
        'model-b': { kind: 'text', text: 'bbbb' },
      },
      charges: [textCharge('classify'), textCharge('model-a'), textCharge('model-b')],
    };
    const total = withStorageFees(request, 10).reduce(
      (sum, charge) => sum + (charge.storageFeeNanoUsd ?? 0n),
      0n
    );
    expect(total).toBe(BigInt(10 + 2 + 4) * CHAR);
  });
});

describe('collectPersistableCharges', () => {
  it('is empty when a run charged only a generation that persists nothing', () => {
    const request: SettlementRequest = {
      runKey: 'k',
      outputs: {},
      charges: [textCharge('classify')],
    };
    expect(collectPersistableCharges(request)).toEqual([]);
  });

  it('holds the charges whose content the run surfaced', () => {
    const request: SettlementRequest = {
      runKey: 'k',
      outputs: { 'model-a': { kind: 'text', text: 'aa' } },
      charges: [textCharge('classify'), textCharge('model-a')],
    };
    expect(collectPersistableCharges(request).map((item) => item.charge.key)).toEqual(['model-a']);
  });
});
