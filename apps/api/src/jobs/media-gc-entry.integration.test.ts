import { LOCAL_NEON_DEV_CONFIG, createDb } from '@hushbox/db';
import { afterAll, describe, expect, it } from 'vitest';
import { okAsync } from '../lib/result/index.js';
import { createMediaGcEntry, productionMediaGcDeps } from './media-gc-entry.js';
import type { Database } from '@hushbox/db';
import type { MediaGcDeps, Storage } from '../slices/media/index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for media GC entry integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });

afterAll(async () => {
  await db.$client.end();
});

// GC under isCI: false never writes evidence, so the db handle is unused by
// an empty sweep; the poisoned proxy proves it.
const untouchedDb = new Proxy(
  {},
  {
    get() {
      throw new Error('an empty GC sweep must not touch the database');
    },
  }
) as Database;

function emptyListingStorage(listed: string[]): Storage {
  return {
    put: () => okAsync(),
    presignGet: () => {
      throw new Error('unused');
    },
    head: () => okAsync(null),
    delete: () => okAsync(),
    list: (prefix) => {
      listed.push(prefix);
      return okAsync({ objects: [] });
    },
  };
}

describe('createMediaGcEntry', () => {
  it('resolves the deps lazily and sweeps both storage prefixes', async () => {
    const listed: string[] = [];
    const deps: MediaGcDeps = {
      storage: emptyListingStorage(listed),
      references: { referencedStorageKeys: () => okAsync(new Set<string>()) },
      now: () => new Date(),
      db: untouchedDb,
      isCI: false,
    };
    const entry = createMediaGcEntry(() => deps);
    expect(entry.name).toBe('media-gc');
    await entry.run();
    expect(listed).toEqual(['media/', 'inputs/']);
  });

  it('surfaces a dep-resolution failure as the entry failure', async () => {
    const entry = createMediaGcEntry(() => {
      throw new Error('R2_S3_ENDPOINT is required');
    });
    await expect(entry.run()).rejects.toThrow('R2_S3_ENDPOINT is required');
  });
});

describe('productionMediaGcDeps', () => {
  it('binds real storage and the content-item reference reader from env', () => {
    const deps = productionMediaGcDeps({
      env: process.env as Parameters<typeof productionMediaGcDeps>[0]['env'],
      db,
      now: () => new Date(),
      isCI: false,
    });
    expect(typeof deps.storage.list).toBe('function');
    expect(typeof deps.references.referencedStorageKeys).toBe('function');
    expect(deps.isCI).toBe(false);
  });
});
