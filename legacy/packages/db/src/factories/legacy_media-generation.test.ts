import { describe, it, expect } from 'vitest';

import { mediaGenerationFactory } from './legacy_media-generation';

describe('mediaGenerationFactory', () => {
  it('builds a valid media generation row', () => {
    const row = mediaGenerationFactory.build();

    expect(row.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(row.usageRecordId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(['image', 'video', 'audio']).toContain(row.mediaType);
    expect(row.model).toEqual(expect.any(String));
    expect(row.provider).toEqual(expect.any(String));
  });

  it('populates image_count for image generations and leaves duration/resolution null', () => {
    const row = mediaGenerationFactory.build({ mediaType: 'image' });

    expect(row.mediaType).toBe('image');
    expect(row.imageCount).toBe(1);
    expect(row.durationMs).toBeNull();
    expect(row.resolution).toBeNull();
  });

  it('populates duration_ms and resolution for video generations', () => {
    const row = mediaGenerationFactory.build({ mediaType: 'video' });

    expect(row.mediaType).toBe('video');
    expect(row.imageCount).toBeNull();
    expect(row.durationMs).toEqual(expect.any(Number));
    expect(['720p', '1080p']).toContain(row.resolution);
  });

  it('populates duration_ms and leaves image_count/resolution null for audio', () => {
    const row = mediaGenerationFactory.build({ mediaType: 'audio' });

    expect(row.mediaType).toBe('audio');
    expect(row.imageCount).toBeNull();
    expect(row.durationMs).toEqual(expect.any(Number));
    expect(row.resolution).toBeNull();
  });
});
