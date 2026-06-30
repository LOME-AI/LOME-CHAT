import { describe, it, expect, vi } from 'vitest';

vi.mock('aws4fetch', () => ({
  AwsClient: class MockAwsClient {
    fetch = vi.fn();
    sign = vi.fn();
  },
}));

const { getMediaStorage } = await import('./index.js');

describe('getMediaStorage', () => {
  it('constructs a MediaStorage from valid env config', () => {
    const storage = getMediaStorage({
      R2_S3_ENDPOINT: 'https://abc.r2.cloudflarestorage.com',
      R2_ACCESS_KEY_ID: 'k',
      R2_SECRET_ACCESS_KEY: 's',
      R2_BUCKET_MEDIA: 'b',
    });
    expect(typeof storage.put).toBe('function');
    expect(typeof storage.delete).toBe('function');
    expect(typeof storage.list).toBe('function');
    expect(typeof storage.mintDownloadUrl).toBe('function');
  });

  it('throws when R2 config is incomplete', () => {
    expect(() =>
      getMediaStorage({
        R2_S3_ENDPOINT: 'https://abc.r2.cloudflarestorage.com',
        R2_BUCKET_MEDIA: 'b',
      })
    ).toThrow(/R2_ACCESS_KEY_ID/);
  });
});
