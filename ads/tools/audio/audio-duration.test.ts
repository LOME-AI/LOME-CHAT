import { describe, expect, it } from 'vitest';

import { flacHeaderDurationSeconds, wavDurationSeconds } from './audio-duration.js';
import { buildFlac, buildWav } from './audio-fixtures.js';

describe('wavDurationSeconds', () => {
  it('returns data size divided by byte rate', () => {
    expect(wavDurationSeconds(buildWav({ byteRate: 1000, dataSize: 2500 }))).toBe(2.5);
  });

  it('rejects a buffer too short to hold a header', () => {
    expect(() => wavDurationSeconds(Buffer.alloc(20))).toThrow(/not a RIFF\/WAVE buffer/);
  });

  it('rejects a buffer whose RIFF tag is wrong', () => {
    expect(() => wavDurationSeconds(buildWav({ riffTag: 'XXXX' }))).toThrow(
      /not a RIFF\/WAVE buffer/
    );
  });

  it('rejects a buffer whose WAVE tag is wrong', () => {
    expect(() => wavDurationSeconds(buildWav({ waveTag: 'XXXX' }))).toThrow(
      /not a RIFF\/WAVE buffer/
    );
  });

  it('rejects a buffer with no fmt chunk', () => {
    expect(() => wavDurationSeconds(buildWav({ includeFormat: false }))).toThrow(
      /missing fmt\/data chunk/
    );
  });

  it('rejects a buffer with no data chunk', () => {
    expect(() => wavDurationSeconds(buildWav({ includeData: false }))).toThrow(
      /missing fmt\/data chunk/
    );
  });

  it('rejects a buffer whose byte rate is zero', () => {
    expect(() => wavDurationSeconds(buildWav({ byteRate: 0 }))).toThrow(/missing fmt\/data chunk/);
  });
});

describe('flacHeaderDurationSeconds', () => {
  it('returns total samples divided by sample rate', () => {
    expect(
      flacHeaderDurationSeconds(buildFlac({ sampleRate: 44_100, totalSamples: 110_250 }))
    ).toBe(2.5);
  });

  it('returns null when the encoder omitted the total-sample count', () => {
    expect(flacHeaderDurationSeconds(buildFlac({ totalSamples: 0 }))).toBeNull();
  });

  it('rejects a buffer too short to hold STREAMINFO', () => {
    expect(() => flacHeaderDurationSeconds(Buffer.from('fLaC'))).toThrow(/not a FLAC buffer/);
  });

  it('rejects a buffer whose FLAC marker is wrong', () => {
    expect(() => flacHeaderDurationSeconds(buildFlac({ marker: 'XXXX' }))).toThrow(
      /not a FLAC buffer/
    );
  });

  it('rejects a file whose first metadata block is not STREAMINFO', () => {
    expect(() => flacHeaderDurationSeconds(buildFlac({ blockType: 1 }))).toThrow(/not STREAMINFO/);
  });

  it('rejects a file whose sample rate is zero', () => {
    expect(() => flacHeaderDurationSeconds(buildFlac({ sampleRate: 0 }))).toThrow(
      /sample rate is zero/
    );
  });
});
