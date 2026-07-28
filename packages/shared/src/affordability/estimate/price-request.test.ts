import { describe, expect, it } from 'vitest';

import { ESTIMATED_IMAGE_BYTES } from '../constants.js';
import { STORAGE_COST_PER_CHARACTER_NANO } from './storage-rate.js';
import { priceRequest } from './price-request.js';
import type { BillableRequest, NanoLineItem } from './types.js';

function itemByLabel(items: readonly NanoLineItem[], label: string): NanoLineItem {
  const found = items.find((index) => index.label === label);
  if (!found) throw new Error(`no line item labelled ${label}`);
  return found;
}

const baseReq: BillableRequest = {
  models: [{ pricing: { inputPerToken: 5n, outputPerToken: 15n } }],
  inputTokens: 100n,
  inputChars: 1000,
  outputCharsPerToken: 4,
};

describe('priceRequest — text/token path', () => {
  it('prices input tokens as a provider fixed item summed across models', () => {
    const req: BillableRequest = {
      ...baseReq,
      models: [
        { pricing: { inputPerToken: 5n, outputPerToken: 15n } },
        { pricing: { inputPerToken: 2n, outputPerToken: 8n } },
      ],
    };
    const res = priceRequest(req);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const input = itemByLabel(res.value.items, 'text-input-tokens');
    // (5 + 2) input rate summed × 100 tokens
    expect(input.fixedNano).toBe(700n);
    expect(input.kind).toBe('provider');
  });

  it('prices output tokens as a provider variable rate summed across models', () => {
    const req: BillableRequest = {
      ...baseReq,
      models: [
        { pricing: { inputPerToken: 5n, outputPerToken: 15n } },
        { pricing: { inputPerToken: 2n, outputPerToken: 8n } },
      ],
    };
    const res = priceRequest(req);
    if (!res.ok) throw new Error('expected ok');
    const output = itemByLabel(res.value.items, 'text-output-tokens');
    expect(output.variableOutputRateNano).toBe(23n);
    expect(output.kind).toBe('provider');
  });

  it('adds input storage as a pass-through storage fixed item', () => {
    const res = priceRequest(baseReq);
    if (!res.ok) throw new Error('expected ok');
    const storage = itemByLabel(res.value.items, 'input-storage');
    expect(storage.fixedNano).toBe(1000n * STORAGE_COST_PER_CHARACTER_NANO);
    expect(storage.kind).toBe('storage');
  });

  it('adds output storage as a per-model, tier-inverted pass-through variable rate', () => {
    const req: BillableRequest = {
      ...baseReq,
      models: [
        { pricing: { inputPerToken: 5n, outputPerToken: 15n } },
        { pricing: { inputPerToken: 2n, outputPerToken: 8n } },
      ],
      outputCharsPerToken: 4,
    };
    const res = priceRequest(req);
    if (!res.ok) throw new Error('expected ok');
    const storage = itemByLabel(res.value.items, 'output-storage');
    // 4 chars/token × 300 nano/char × 2 models
    expect(storage.variableOutputRateNano).toBe(4n * STORAGE_COST_PER_CHARACTER_NANO * 2n);
    expect(storage.kind).toBe('storage');
  });

  it('handles a zero-length prompt with zero-cost fixed items', () => {
    const res = priceRequest({ ...baseReq, inputTokens: 0n, inputChars: 0 });
    if (!res.ok) throw new Error('expected ok');
    expect(itemByLabel(res.value.items, 'text-input-tokens').fixedNano).toBe(0n);
    expect(itemByLabel(res.value.items, 'input-storage').fixedNano).toBe(0n);
  });

  it('applies no fee math in priceRequest — every amount is the billable rate as given', () => {
    const res = priceRequest(baseReq);
    if (!res.ok) throw new Error('expected ok');
    // input tokens: 5 × 100 = 500 exactly as given — no fee math applied
    expect(itemByLabel(res.value.items, 'text-input-tokens').fixedNano).toBe(500n);
    expect(itemByLabel(res.value.items, 'text-output-tokens').variableOutputRateNano).toBe(15n);
  });
});

describe('priceRequest — modality dispatch', () => {
  it('prices an image request as media line items, not token items', () => {
    const res = priceRequest({
      ...baseReq,
      modality: 'image',
      models: [{ pricing: { perImage: 200_000_000n } }],
      media: { rateKey: 'perImage', units: 1, storageBytes: ESTIMATED_IMAGE_BYTES },
    });
    if (!res.ok) throw new Error('expected ok');
    const labels = res.value.items.map((entry) => entry.label);
    expect(labels).toContain('media-generation');
    expect(labels).toContain('media-storage');
    expect(labels).not.toContain('text-input-tokens');
  });

  it('defaults an absent modality to the text/token path', () => {
    const res = priceRequest(baseReq);
    if (!res.ok) throw new Error('expected ok');
    expect(res.value.items.map((entry) => entry.label)).toContain('text-input-tokens');
  });

  it('fails closed on a media modality with no media descriptor', () => {
    const res = priceRequest({ ...baseReq, modality: 'image' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('invalid-request');
  });

  it('fails closed on the non-priceable embedding modality', () => {
    const res = priceRequest({ ...baseReq, modality: 'embedding' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('invalid-request');
  });
});

describe('priceRequest — web search + classifier line items', () => {
  it('adds the per-model web-search reservation when webSearch is set', () => {
    const res = priceRequest({ ...baseReq, webSearch: true });
    if (!res.ok) throw new Error('expected ok');
    const search = res.value.items.find((entry) => entry.label === 'web-search-reservation');
    // The billable (fee-baked-at-definition) worst case: 10 calls × $0.005 × 1.15.
    expect(search?.fixedNano).toBe(57_500_000n);
    expect(search?.kind).toBe('provider');
  });

  it('omits the web-search reservation by default', () => {
    const res = priceRequest(baseReq);
    if (!res.ok) throw new Error('expected ok');
    expect(res.value.items.some((entry) => entry.label === 'web-search-reservation')).toBe(false);
  });

  it('folds the classifier pre-reserve into the manifest, provider leg only', () => {
    const res = priceRequest({
      ...baseReq,
      classifierStage: {
        pricing: { inputPerToken: 5n, outputPerToken: 15n },
        inputTokens: 100n,
      },
    });
    if (!res.ok) throw new Error('expected ok');
    const classifierItems = res.value.items.filter((entry) => entry.label.startsWith('classifier'));
    expect(classifierItems.map((entry) => entry.label)).toEqual(['classifier-tokens']);
  });

  it('fails closed when the classifier pricing is incomplete', () => {
    const res = priceRequest({
      ...baseReq,
      classifierStage: {
        pricing: { inputPerToken: 5n },
        inputTokens: 100n,
      },
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('model-pricing-incomplete');
  });
});

describe('priceRequest — fail-closed', () => {
  it('rejects an empty model set', () => {
    const res = priceRequest({ ...baseReq, models: [] });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('invalid-request');
  });

  it('rejects a model missing its input rate', () => {
    const res = priceRequest({ ...baseReq, models: [{ pricing: { outputPerToken: 15n } }] });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('model-pricing-incomplete');
  });

  it('rejects a model missing its output rate', () => {
    const res = priceRequest({ ...baseReq, models: [{ pricing: { inputPerToken: 5n } }] });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('model-pricing-incomplete');
  });

  it('rejects a negative input token count', () => {
    const res = priceRequest({ ...baseReq, inputTokens: -1n });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('invalid-request');
  });

  it('rejects a non-integer or negative input char count', () => {
    expect(priceRequest({ ...baseReq, inputChars: -5 }).ok).toBe(false);
    expect(priceRequest({ ...baseReq, inputChars: 1.5 }).ok).toBe(false);
  });

  it('rejects a non-integer or negative output chars-per-token', () => {
    expect(priceRequest({ ...baseReq, outputCharsPerToken: 0 }).ok).toBe(false);
    expect(priceRequest({ ...baseReq, outputCharsPerToken: -2 }).ok).toBe(false);
    expect(priceRequest({ ...baseReq, outputCharsPerToken: 2.5 }).ok).toBe(false);
  });
});
