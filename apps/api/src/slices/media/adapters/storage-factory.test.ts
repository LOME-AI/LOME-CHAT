import { describe, expect, it } from 'vitest';
import {
  NON_PROD_STORAGE_NETWORK,
  createR2StorageFromEnv,
  storageNetworkForEnv,
} from './storage-factory.js';
import type { Database } from '@hushbox/db';

// Construction never records evidence, so the db is untouched; a throwing stub
// proves it and keeps this a pure unit test.
const NO_DB = new Proxy(
  {},
  {
    get() {
      throw new Error('storage-factory unit test must not touch the database');
    },
  }
) as Database;

interface FactoryEnv {
  NODE_ENV: string;
  R2_S3_ENDPOINT?: string;
  R2_BUCKET_MEDIA?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
}

function fullEnv(overrides: Partial<FactoryEnv> = {}): FactoryEnv {
  return {
    NODE_ENV: 'development',
    R2_S3_ENDPOINT: 'https://example.r2.cloudflarestorage.com',
    R2_BUCKET_MEDIA: 'media',
    R2_ACCESS_KEY_ID: 'key',
    R2_SECRET_ACCESS_KEY: 'secret',
    ...overrides,
  };
}

describe('createR2StorageFromEnv', () => {
  it.each([
    'R2_S3_ENDPOINT',
    'R2_BUCKET_MEDIA',
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
  ] as const)('fails fast when %s is missing', (field) => {
    expect(() => createR2StorageFromEnv(fullEnv({ [field]: undefined }), NO_DB)).toThrow(field);
  });

  it('builds a Storage adapter when every binding is present', () => {
    const storage = createR2StorageFromEnv(fullEnv(), NO_DB);
    expect(typeof storage.put).toBe('function');
    expect(typeof storage.presignGet).toBe('function');
    expect(typeof storage.delete).toBe('function');
  });
});

describe('storageNetworkForEnv', () => {
  it('widens the retry window in local development', () => {
    expect(storageNetworkForEnv({ NODE_ENV: 'development' })).toStrictEqual(
      NON_PROD_STORAGE_NETWORK
    );
  });

  it('widens the retry window in CI (non-production, CI set)', () => {
    expect(storageNetworkForEnv({ NODE_ENV: 'development', CI: 'true' })).toStrictEqual(
      NON_PROD_STORAGE_NETWORK
    );
  });

  it('injects a maxRetries and maxDelayMs wider than the fail-fast default', () => {
    // storage-r2's DEFAULT_NETWORK is maxRetries:2 / maxDelayMs:1000; the
    // non-prod window rides out a multi-second MinIO contention burst.
    expect(NON_PROD_STORAGE_NETWORK.maxRetries).toBe(8);
    expect(NON_PROD_STORAGE_NETWORK.maxDelayMs).toBe(5000);
  });

  it('returns undefined in production so DEFAULT_NETWORK (fail fast) stands', () => {
    expect(storageNetworkForEnv({ NODE_ENV: 'production' })).toBeUndefined();
  });
});
