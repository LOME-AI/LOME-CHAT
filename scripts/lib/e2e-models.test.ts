import { describe, it, expect } from 'vitest';
import { E2E_MODELS, e2eModelIds } from './e2e-models.js';

const MODALITIES = ['text', 'image', 'video'] as const;

// A well-formed OpenRouter id is `provider/model` — lowercase provider slug, a
// single slash, a non-empty model segment.
const WELL_FORMED_ID = /^[a-z0-9-]+\/[a-zA-Z0-9._-]+$/;

describe('E2E_MODELS', () => {
  it('has a non-empty set per modality', () => {
    for (const modality of MODALITIES) {
      expect(E2E_MODELS[modality].length).toBeGreaterThan(0);
    }
  });

  it('has well-formed provider/model ids in every modality', () => {
    for (const modality of MODALITIES) {
      for (const id of E2E_MODELS[modality]) {
        expect(id).toMatch(WELL_FORMED_ID);
      }
    }
  });

  it('exposes no duplicate ids across modalities', () => {
    const ids = e2eModelIds();
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('flattens every modality into e2eModelIds', () => {
    expect(e2eModelIds()).toEqual([...E2E_MODELS.text, ...E2E_MODELS.image, ...E2E_MODELS.video]);
  });
});
