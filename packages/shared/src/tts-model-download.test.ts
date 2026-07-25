import { describe, expect, it } from 'vitest';

import { TTS_MODEL_DOWNLOAD_BYTES, TTS_MODEL_DOWNLOAD_MB } from './tts-model-download.js';

describe('TTS model download size', () => {
  it('is the verified friendly first-listen size, in whole MB', () => {
    expect(TTS_MODEL_DOWNLOAD_MB).toBe(90);
  });

  it('is a whole number of MB (a friendly display figure, not a raw byte count)', () => {
    expect(Number.isInteger(TTS_MODEL_DOWNLOAD_MB)).toBe(true);
  });

  it('exposes the exact byte total of the same first-listen download', () => {
    expect(TTS_MODEL_DOWNLOAD_BYTES).toBe(92_887_010);
  });

  it('keeps the byte total and the friendly MB figure describing one download', () => {
    expect(Math.abs(TTS_MODEL_DOWNLOAD_BYTES / 1_000_000 - TTS_MODEL_DOWNLOAD_MB)).toBeLessThan(5);
  });
});
