import { afterEach, describe, expect, it } from 'vitest';
import { createScratchBucket } from './test-fixtures.js';

describe('createScratchBucket', () => {
  const savedEndpoint = process.env['R2_S3_ENDPOINT'];

  afterEach(() => {
    process.env['R2_S3_ENDPOINT'] = savedEndpoint;
  });

  it('fails fast when the storage environment is missing', async () => {
    delete process.env['R2_S3_ENDPOINT'];

    await expect(createScratchBucket()).rejects.toThrow('R2_S3_ENDPOINT');
  });

  it('surfaces a failed bucket create', async () => {
    // Path-style request lands as an object PUT into a bucket that does not
    // exist, so the server answers non-2xx and no bucket is ever created.
    process.env['R2_S3_ENDPOINT'] = `${savedEndpoint ?? ''}/no-such-bucket-prefix`;

    await expect(createScratchBucket()).rejects.toThrow('create');
  });
});
