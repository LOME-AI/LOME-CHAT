import { describe, expect, it } from 'vitest';
import { createR2StorageFromEnv } from './storage-factory.js';
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
