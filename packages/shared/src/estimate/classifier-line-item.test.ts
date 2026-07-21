import { describe, expect, it } from 'vitest';

import { MAX_CLASSIFIER_CONTEXT_CHARS } from '../smart-model/truncate.js';
import { computeClassifierPromptOverhead } from '../smart-model/prompts.js';
import { CLASSIFIER_OUTPUT_TOKEN_CAP } from '../smart-model/eligible-models.js';
import { classifierLineItems, classifierReserveChars } from './classifier-line-item.js';
import { STORAGE_COST_PER_CHARACTER_NANO } from './storage-rate.js';
import type { ClassifierStage, NanoLineItem } from './types.js';

function itemByLabel(items: readonly NanoLineItem[], label: string): NanoLineItem {
  const found = items.find((entry) => entry.label === label);
  if (!found) throw new Error(`no line item labelled ${label}`);
  return found;
}

const stage: ClassifierStage = {
  pricing: { inputPerToken: 5n, outputPerToken: 15n },
  inputTokens: 100n,
  inputChars: 1000,
};

describe('classifierReserveChars', () => {
  it('is the truncation budget plus the exact rendered prompt overhead', () => {
    const catalog = [
      { id: 'a/one', description: 'first' },
      { id: 'b/two', description: 'second' },
    ];
    expect(classifierReserveChars(catalog)).toBe(
      MAX_CLASSIFIER_CONTEXT_CHARS + computeClassifierPromptOverhead(catalog)
    );
  });

  it('treats a missing description as empty when rendering overhead', () => {
    const withUndefined = [{ id: 'a/one' }];
    expect(classifierReserveChars(withUndefined)).toBe(
      MAX_CLASSIFIER_CONTEXT_CHARS +
        computeClassifierPromptOverhead([{ id: 'a/one', description: '' }])
    );
  });
});

describe('classifierLineItems', () => {
  it('prices input tokens + the fixed output cap as a marked-up item', () => {
    const res = classifierLineItems(stage, 4);
    if (!res.ok) throw new Error('expected ok');
    const provider = itemByLabel(res.value, 'classifier-tokens');
    // 100 × 5 (input) + CAP × 15 (output) — reproduces computeClassifierWorstCaseCents' model legs.
    expect(provider.fixedNano).toBe(100n * 5n + BigInt(CLASSIFIER_OUTPUT_TOKEN_CAP) * 15n);
    expect(provider.marksUp).toBe(true);
  });

  it('prices input + output storage as a never-marked-up item', () => {
    const res = classifierLineItems(stage, 4);
    if (!res.ok) throw new Error('expected ok');
    const storage = itemByLabel(res.value, 'classifier-storage');
    // inputChars×rate + CAP×outputCharsPerToken×rate — the storage legs, tier-inverted output.
    expect(storage.fixedNano).toBe(
      1000n * STORAGE_COST_PER_CHARACTER_NANO +
        BigInt(CLASSIFIER_OUTPUT_TOKEN_CAP) * 4n * STORAGE_COST_PER_CHARACTER_NANO
    );
    expect(storage.marksUp).toBe(false);
  });

  it('fails closed when the classifier pricing lacks an input rate', () => {
    const res = classifierLineItems({ ...stage, pricing: { outputPerToken: 15n } }, 4);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('model-pricing-incomplete');
  });

  it('fails closed when the classifier pricing lacks an output rate', () => {
    const res = classifierLineItems({ ...stage, pricing: { inputPerToken: 5n } }, 4);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('model-pricing-incomplete');
  });

  it('rejects a negative input token count', () => {
    const res = classifierLineItems({ ...stage, inputTokens: -1n }, 4);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('invalid-request');
  });

  it('rejects a non-integer or negative input char count', () => {
    expect(classifierLineItems({ ...stage, inputChars: -1 }, 4).ok).toBe(false);
    expect(classifierLineItems({ ...stage, inputChars: 1.5 }, 4).ok).toBe(false);
  });

  it('rejects a non-positive output chars-per-token', () => {
    expect(classifierLineItems(stage, 0).ok).toBe(false);
    expect(classifierLineItems(stage, -2).ok).toBe(false);
  });
});
