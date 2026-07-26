import { describe, expect, it } from 'vitest';

import {
  ESTIMATED_AUDIO_BYTES_PER_SECOND,
  ESTIMATED_IMAGE_BYTES,
  ESTIMATED_VIDEO_BYTES_PER_SECOND,
} from '../constants.js';
import { buildMediaLineItems } from './media-pricing.js';
import { MEDIA_STORAGE_COST_PER_BYTE_NANO } from './storage-rate.js';
import type { BillableRequest, NanoLineItem } from './types.js';

function itemByLabel(items: readonly NanoLineItem[], label: string): NanoLineItem {
  const found = items.find((entry) => entry.label === label);
  if (!found) throw new Error(`no line item labelled ${label}`);
  return found;
}

// A media request shares BillableRequest's always-present fields; the text-only
// fields are unused on the media path and carry harmless placeholders.
const mediaBase = {
  inputTokens: 0n,
  inputChars: 0,
  outputCharsPerToken: 4,
} satisfies Pick<BillableRequest, 'inputTokens' | 'inputChars' | 'outputCharsPerToken'>;

describe('buildMediaLineItems — image (deterministic)', () => {
  it('prices per-image rate × 1 unit summed across models as a provider item', () => {
    const req: BillableRequest = {
      ...mediaBase,
      modality: 'image',
      models: [{ pricing: { perImage: 200_000_000n } }, { pricing: { perImage: 100_000_000n } }],
      media: { rateKey: 'perImage', units: 1, storageBytes: ESTIMATED_IMAGE_BYTES },
    };
    const res = buildMediaLineItems(req);
    if (!res.ok) throw new Error('expected ok');
    const provider = itemByLabel(res.value, 'media-generation');
    // (200M + 100M) × 1 unit
    expect(provider.fixedNano).toBe(300_000_000n);
    expect(provider.kind).toBe('provider');
  });

  it('adds media storage as a per-model, never-marked-up byte cost', () => {
    const req: BillableRequest = {
      ...mediaBase,
      modality: 'image',
      models: [{ pricing: { perImage: 200_000_000n } }, { pricing: { perImage: 100_000_000n } }],
      media: { rateKey: 'perImage', units: 1, storageBytes: ESTIMATED_IMAGE_BYTES },
    };
    const res = buildMediaLineItems(req);
    if (!res.ok) throw new Error('expected ok');
    const storage = itemByLabel(res.value, 'media-storage');
    // ESTIMATED_IMAGE_BYTES × 18 nano/byte × 2 models — reproduces
    // computeImageExactCents' `mediaStorageCost(bytes) × prices.length`.
    expect(storage.fixedNano).toBe(
      BigInt(ESTIMATED_IMAGE_BYTES) * MEDIA_STORAGE_COST_PER_BYTE_NANO * 2n
    );
    expect(storage.kind).toBe('storage');
  });
});

describe('buildMediaLineItems — video (by resolution × duration)', () => {
  it('prices the resolution rate × duration seconds as a provider item', () => {
    const durationSeconds = 6;
    const req: BillableRequest = {
      ...mediaBase,
      modality: 'video',
      models: [{ pricing: { perSecondByResolution: { '1080p': 50_000_000n } } }],
      media: {
        rateKey: 'perSecondByResolution',
        dimensionKey: '1080p',
        units: durationSeconds,
        storageBytes: durationSeconds * ESTIMATED_VIDEO_BYTES_PER_SECOND,
      },
    };
    const res = buildMediaLineItems(req);
    if (!res.ok) throw new Error('expected ok');
    // 50M/sec × 6 sec — reproduces computeVideoExactCents (price × duration).
    expect(itemByLabel(res.value, 'media-generation').fixedNano).toBe(300_000_000n);
    expect(itemByLabel(res.value, 'media-storage').fixedNano).toBe(
      BigInt(durationSeconds * ESTIMATED_VIDEO_BYTES_PER_SECOND) * MEDIA_STORAGE_COST_PER_BYTE_NANO
    );
  });
});

describe('buildMediaLineItems — audio (worst-case max duration)', () => {
  it('prices the flat per-second rate × max duration as a provider item', () => {
    const maxDurationSeconds = 30;
    const req: BillableRequest = {
      ...mediaBase,
      modality: 'audio',
      models: [{ pricing: { perSecond: 1_000_000n } }],
      media: {
        rateKey: 'perSecond',
        units: maxDurationSeconds,
        storageBytes: maxDurationSeconds * ESTIMATED_AUDIO_BYTES_PER_SECOND,
      },
    };
    const res = buildMediaLineItems(req);
    if (!res.ok) throw new Error('expected ok');
    // 1M/sec × 30 sec — reproduces computeAudioWorstCaseCents (price × maxDuration).
    expect(itemByLabel(res.value, 'media-generation').fixedNano).toBe(30_000_000n);
    expect(itemByLabel(res.value, 'media-storage').fixedNano).toBe(
      BigInt(maxDurationSeconds * ESTIMATED_AUDIO_BYTES_PER_SECOND) *
        MEDIA_STORAGE_COST_PER_BYTE_NANO
    );
  });
});

describe('buildMediaLineItems — fail-closed', () => {
  const imageModels = [{ pricing: { perImage: 200_000_000n } }];

  it('rejects a request with no media descriptor', () => {
    const req: BillableRequest = { ...mediaBase, modality: 'image', models: imageModels };
    const res = buildMediaLineItems(req);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('invalid-request');
  });

  it('rejects an empty model set', () => {
    const res = buildMediaLineItems({
      ...mediaBase,
      modality: 'image',
      models: [],
      media: { rateKey: 'perImage', units: 1, storageBytes: ESTIMATED_IMAGE_BYTES },
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('invalid-request');
  });

  it('fails closed when a model lacks the requested flat rate', () => {
    const res = buildMediaLineItems({
      ...mediaBase,
      modality: 'image',
      models: [{ pricing: {} }],
      media: { rateKey: 'perImage', units: 1, storageBytes: ESTIMATED_IMAGE_BYTES },
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('model-pricing-incomplete');
  });

  it('fails closed when the resolution is absent from the rate matrix', () => {
    const res = buildMediaLineItems({
      ...mediaBase,
      modality: 'video',
      models: [{ pricing: { perSecondByResolution: { '720p': 10_000_000n } } }],
      media: { rateKey: 'perSecondByResolution', dimensionKey: '4k', units: 3, storageBytes: 1 },
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('model-pricing-incomplete');
  });

  it('fails closed when the model has no resolution matrix at all', () => {
    const res = buildMediaLineItems({
      ...mediaBase,
      modality: 'video',
      models: [{ pricing: {} }],
      media: { rateKey: 'perSecondByResolution', dimensionKey: '1080p', units: 3, storageBytes: 1 },
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('model-pricing-incomplete');
  });

  it('never resolves an inherited matrix member (prototype-pollution guard)', () => {
    const res = buildMediaLineItems({
      ...mediaBase,
      modality: 'video',
      models: [{ pricing: { perSecondByResolution: { '720p': 10_000_000n } } }],
      media: {
        rateKey: 'perSecondByResolution',
        dimensionKey: 'constructor',
        units: 3,
        storageBytes: 1,
      },
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('model-pricing-incomplete');
  });

  it('rejects a flat rate carrying a dimension key', () => {
    const res = buildMediaLineItems({
      ...mediaBase,
      modality: 'image',
      models: imageModels,
      media: { rateKey: 'perImage', dimensionKey: 'oops', units: 1, storageBytes: 1 },
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('invalid-request');
  });

  it('rejects a matrix rate missing its dimension key', () => {
    const res = buildMediaLineItems({
      ...mediaBase,
      modality: 'video',
      models: [{ pricing: { perSecondByResolution: { '720p': 10_000_000n } } }],
      media: { rateKey: 'perSecondByResolution', units: 3, storageBytes: 1 },
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('invalid-request');
  });

  it('rejects non-positive or non-integer units', () => {
    for (const units of [0, -1, 1.5]) {
      const res = buildMediaLineItems({
        ...mediaBase,
        modality: 'image',
        models: imageModels,
        media: { rateKey: 'perImage', units, storageBytes: ESTIMATED_IMAGE_BYTES },
      });
      expect(res.ok).toBe(false);
    }
  });

  it('rejects negative or non-integer storage bytes', () => {
    for (const storageBytes of [-1, 2.5]) {
      const res = buildMediaLineItems({
        ...mediaBase,
        modality: 'image',
        models: imageModels,
        media: { rateKey: 'perImage', units: 1, storageBytes },
      });
      expect(res.ok).toBe(false);
    }
  });
});
