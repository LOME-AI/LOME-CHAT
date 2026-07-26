import { describe, expect, it } from 'vitest';
import { MODALITIES, Modality } from './modality.js';

describe('MODALITIES', () => {
  it('contains exactly the five closed modalities in order', () => {
    expect(MODALITIES).toEqual(['text', 'image', 'audio', 'video', 'embedding']);
  });
});

describe('Modality', () => {
  it('parses every member of the closed set', () => {
    for (const modality of MODALITIES) {
      expect(Modality.safeParse(modality).success).toBe(true);
    }
  });

  it('rejects an unknown string', () => {
    expect(Modality.safeParse('speech').success).toBe(false);
  });

  it('is closed at the type level', () => {
    // @ts-expect-error -- 'speech' is not a member of the closed Modality union
    const invalid: Modality = 'speech';
    expect(MODALITIES).not.toContain(invalid);
  });
});
