import { describe, it, expect, vi } from 'vitest';
import { ensureMediaBucketReady, MEDIA_BUCKET } from './minio-bucket-ready.js';

describe('ensureMediaBucketReady', () => {
  it('resolves without running setup when the bucket already exists', async () => {
    const probeBucket = vi.fn().mockResolvedValue(true);
    const runBucketSetup = vi.fn(async () => {});

    await ensureMediaBucketReady({ probeBucket, runBucketSetup });

    expect(probeBucket).toHaveBeenCalledTimes(1);
    expect(runBucketSetup).not.toHaveBeenCalled();
  });

  it('runs setup then resolves once the bucket appears', async () => {
    const probeBucket = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const runBucketSetup = vi.fn(async () => {});

    await ensureMediaBucketReady({ probeBucket, runBucketSetup });

    expect(runBucketSetup).toHaveBeenCalledTimes(1);
    expect(probeBucket).toHaveBeenCalledTimes(2);
  });

  it('fails loud when the bucket is still missing after setup', async () => {
    const probeBucket = vi.fn().mockResolvedValue(false);
    const runBucketSetup = vi.fn(async () => {});

    await expect(ensureMediaBucketReady({ probeBucket, runBucketSetup })).rejects.toThrow(
      MEDIA_BUCKET
    );
    expect(runBucketSetup).toHaveBeenCalledTimes(1);
  });

  it('propagates a setup failure instead of masking it', async () => {
    const probeBucket = vi.fn().mockResolvedValue(false);
    const runBucketSetup = vi.fn().mockRejectedValue(new Error('mc mb exploded'));

    await expect(ensureMediaBucketReady({ probeBucket, runBucketSetup })).rejects.toThrow(
      'mc mb exploded'
    );
    // The re-probe never runs when setup itself failed — the setup error is the truth.
    expect(probeBucket).toHaveBeenCalledTimes(1);
  });
});
