import { describe, it, expect } from 'vitest';
import { VIDEO_ASPECT_RATIOS, VIDEO_RESOLUTIONS, IMAGE_ASPECT_RATIOS } from '../constants.js';
import {
  VEO_CAPABILITY,
  IMAGEN_SAMPLE_SIZE_BY_MODEL,
  getVideoCapability,
  getSupportedVideoDurations,
  getSupportedVideoResolutions,
  getSupportedVideoAspectRatios,
  getImagenSampleSize,
} from './capabilities.js';

describe('getVideoCapability', () => {
  it('returns Veo 3.0 capability with [4,6,8]s and 720p/1080p (no 4k)', () => {
    const cap = getVideoCapability('google/veo-3.0-generate-001');
    expect(cap).toBeDefined();
    expect(cap?.durationsSeconds).toEqual([4, 6, 8]);
    expect(cap?.resolutions).toEqual(['720p', '1080p']);
    expect(cap?.aspectRatios).toEqual(['16:9', '9:16']);
  });

  it('returns Veo 3.1 capability with [4,6,8]s and 720p/1080p/4k', () => {
    const cap = getVideoCapability('google/veo-3.1-generate-001');
    expect(cap).toBeDefined();
    expect(cap?.durationsSeconds).toEqual([4, 6, 8]);
    expect(cap?.resolutions).toEqual(['720p', '1080p', '4k']);
    expect(cap?.aspectRatios).toEqual(['16:9', '9:16']);
  });

  it('returns capability for fast variants identical to their non-fast counterparts', () => {
    expect(getVideoCapability('google/veo-3.0-fast-generate-001')).toEqual(
      getVideoCapability('google/veo-3.0-generate-001')
    );
    expect(getVideoCapability('google/veo-3.1-fast-generate-001')).toEqual(
      getVideoCapability('google/veo-3.1-generate-001')
    );
  });

  it('returns undefined for unknown model ids', () => {
    expect(getVideoCapability('openai/sora-1')).toBeUndefined();
    expect(getVideoCapability('')).toBeUndefined();
  });
});

describe('video capability accessor proxies', () => {
  const veo30 = 'google/veo-3.0-generate-001';

  it('getSupportedVideoDurations returns the durations array', () => {
    expect(getSupportedVideoDurations(veo30)).toEqual([4, 6, 8]);
  });

  it('getSupportedVideoResolutions returns the resolutions array', () => {
    expect(getSupportedVideoResolutions(veo30)).toEqual(['720p', '1080p']);
  });

  it('getSupportedVideoAspectRatios returns the aspect ratios array', () => {
    expect(getSupportedVideoAspectRatios(veo30)).toEqual(['16:9', '9:16']);
  });

  it('all three accessors return undefined for unknown model ids', () => {
    expect(getSupportedVideoDurations('unknown')).toBeUndefined();
    expect(getSupportedVideoResolutions('unknown')).toBeUndefined();
    expect(getSupportedVideoAspectRatios('unknown')).toBeUndefined();
  });
});

describe('getImagenSampleSize', () => {
  it("returns '1K' for imagen-4 fast", () => {
    expect(getImagenSampleSize('google/imagen-4.0-fast-generate-001')).toBe('1K');
  });

  it("returns '2K' for imagen-4 generate and ultra", () => {
    expect(getImagenSampleSize('google/imagen-4.0-generate-001')).toBe('2K');
    expect(getImagenSampleSize('google/imagen-4.0-ultra-generate-001')).toBe('2K');
  });

  it('returns undefined for models without a pinned sample size', () => {
    expect(getImagenSampleSize('google/gemini-2.5-flash-image')).toBeUndefined();
    expect(getImagenSampleSize('openai/dall-e-3')).toBeUndefined();
    expect(getImagenSampleSize('')).toBeUndefined();
  });
});

describe('capability integrity invariants', () => {
  it('every VEO_CAPABILITY resolution is a member of VIDEO_RESOLUTIONS', () => {
    const validResolutions = new Set<string>(VIDEO_RESOLUTIONS);
    for (const [id, cap] of Object.entries(VEO_CAPABILITY)) {
      for (const resolution of cap.resolutions) {
        expect(validResolutions.has(resolution), `${id}: ${resolution}`).toBe(true);
      }
    }
  });

  it('every VEO_CAPABILITY aspectRatio is a member of VIDEO_ASPECT_RATIOS', () => {
    const validAspectRatios = new Set<string>(VIDEO_ASPECT_RATIOS);
    for (const [id, cap] of Object.entries(VEO_CAPABILITY)) {
      for (const aspectRatio of cap.aspectRatios) {
        expect(validAspectRatios.has(aspectRatio), `${id}: ${aspectRatio}`).toBe(true);
      }
    }
  });

  it('every IMAGEN_SAMPLE_SIZE_BY_MODEL value is "1K" or "2K"', () => {
    for (const [id, size] of Object.entries(IMAGEN_SAMPLE_SIZE_BY_MODEL)) {
      expect(['1K', '2K'], id).toContain(size);
    }
  });

  it('IMAGE_ASPECT_RATIOS includes 1:1 as the first entry (default for tests)', () => {
    expect(IMAGE_ASPECT_RATIOS[0]).toBe('1:1');
  });
});
