import { describe, expect, it } from 'vitest';

import {
  buildClassifierSystemPrompt,
  computeClassifierPromptOverhead,
  MAX_CLASSIFIER_CONTEXT_CHARS,
} from '../smart-model/prompts.js';
import { CLASSIFIER_OUTPUT_TOKEN_CAP } from '../smart-model/eligible-models.js';
import { classifierLineItems, classifierReserveChars } from './classifier-line-item.js';
import type { ClassifierStage, NanoLineItem } from './types.js';

function itemByLabel(items: readonly NanoLineItem[], label: string): NanoLineItem {
  const found = items.find((entry) => entry.label === label);
  if (!found) throw new Error(`no line item labelled ${label}`);
  return found;
}

const stage: ClassifierStage = {
  pricing: { inputPerToken: 5n, outputPerToken: 15n },
  inputTokens: 100n,
};

describe('classifierReserveChars', () => {
  const pool = [{ id: 'a/one' }, { id: 'b/two' }];

  it('is the truncation budget plus the worst-case rendered prompt overhead', () => {
    expect(classifierReserveChars(pool)).toBe(
      MAX_CLASSIFIER_CONTEXT_CHARS + computeClassifierPromptOverhead(pool)
    );
  });

  /**
   * The reserve's whole point: it bounds the classifier call the executor will
   * actually send. The excerpt leg is bounded on the emitting side (the
   * truncator emits no more than {@link MAX_CLASSIFIER_CONTEXT_CHARS}, pinned
   * where it lives); the template leg is bounded here, against a real render of
   * the same model list carrying descriptions of any length.
   */
  it('bounds a real render of the same pool, whatever its descriptions say', () => {
    const excerpt = 'e'.repeat(MAX_CLASSIFIER_CONTEXT_CHARS);
    for (const description of ['', 'short', 'x'.repeat(5000)]) {
      const sent =
        buildClassifierSystemPrompt({
          eligibleModels: pool.map((model) => ({ ...model, description })),
          classifyEffort: true,
        }).length + excerpt.length;
      expect(classifierReserveChars(pool)).toBeGreaterThanOrEqual(sent);
    }
  });
});

describe('classifierLineItems', () => {
  it('prices input tokens + the fixed output cap as a provider item', () => {
    const res = classifierLineItems(stage);
    if (!res.ok) throw new Error('expected ok');
    const provider = itemByLabel(res.value, 'classifier-tokens');
    // 100 × 5 (input) + CAP × 15 (output) — reproduces computeClassifierWorstCaseCents' model legs.
    expect(provider.fixedNano).toBe(100n * 5n + BigInt(CLASSIFIER_OUTPUT_TOKEN_CAP) * 15n);
    expect(provider.kind).toBe('provider');
  });

  it('emits NO storage item — the classifier prompt and answer never rest', () => {
    // Asserted on the whole list rather than on one absent label: a reserve that
    // sums its items generically (one live folder does) charges whatever is here,
    // so "nothing but the provider leg" is the property, not "no `storage` label".
    const res = classifierLineItems(stage);
    if (!res.ok) throw new Error('expected ok');
    expect(res.value.map((item) => item.kind)).toEqual(['provider']);
    expect(res.value.map((item) => item.label)).toEqual(['classifier-tokens']);
  });

  it('fails closed when the classifier pricing lacks an input rate', () => {
    const res = classifierLineItems({ ...stage, pricing: { outputPerToken: 15n } });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('model-pricing-incomplete');
  });

  it('fails closed when the classifier pricing lacks an output rate', () => {
    const res = classifierLineItems({ ...stage, pricing: { inputPerToken: 5n } });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('model-pricing-incomplete');
  });

  it('rejects a negative input token count', () => {
    const res = classifierLineItems({ ...stage, inputTokens: -1n });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('invalid-request');
  });
});
