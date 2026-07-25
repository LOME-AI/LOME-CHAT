import { describe, expect, it } from 'vitest';
import {
  MEDIA_STORAGE_COST_PER_BYTE_NANO,
  STORAGE_COST_PER_CHARACTER_NANO,
} from '../../billing/index.js';
import { serializeReasoningText } from '@hushbox/shared';
import { withStorageFees } from './settlement.js';
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
