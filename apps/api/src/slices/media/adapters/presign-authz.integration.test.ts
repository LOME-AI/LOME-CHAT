import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_MEDIA_OBJECT_BYTES, MEDIA_DOWNLOAD_URL_TTL_SECONDS } from '@hushbox/shared';
import { okAsync } from '../../../lib/result/index.js';
import { mediaObjectKey } from '../ports/index.js';
import { authorizePresign } from '../domain/index.js';
import { createR2Storage } from './storage-r2.js';
import type { Database } from '@hushbox/db';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { PresignAuthzDeps } from '../domain/index.js';
import type { MediaTarget, Storage } from '../ports/index.js';

// This suite only presigns/puts under `isCI: false`, so the evidence write —
// the only db consumer — no-ops before touching the handle.
const NO_DB = new Proxy(
  {},
  {
    get() {
      throw new Error('presign suite must not touch the database');
    },
  }
) as Database;

/**
 * End-to-end: the pure authorization decision gates a real MinIO presign.
 * Readers are fakes of this slice's own port interfaces (not internal-slice
 * mocks); the storage adapter and the presigned fetch are real.
 */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required for storage integration tests — run via pnpm test:api`);
  }
  return value;
}

async function unwrap<T>(result: ResultAsync<T, DomainError>): Promise<T> {
  const settled = await result;
  return settled._unsafeUnwrap();
}

const ITEM_ID = crypto.randomUUID();
const EPOCH_ID = crypto.randomUUID();
const CONVERSATION_ID = crypto.randomUUID();
const STORAGE_KEY = mediaObjectKey({
  conversationId: CONVERSATION_ID,
  messageId: crypto.randomUUID(),
  objectId: crypto.randomUUID(),
});
const BYTES = new Uint8Array([42, 42, 42]);

const TARGET: MediaTarget = {
  contentItemId: ITEM_ID,
  conversationId: CONVERSATION_ID,
  epochId: EPOCH_ID,
  contentType: 'image',
  storageKey: STORAGE_KEY,
};

function makeDeps(overrides: {
  isActiveMember?: boolean;
  isEpochMember?: boolean;
  shareCoversItem?: boolean;
}): PresignAuthzDeps {
  return {
    contentItems: { findMediaTarget: () => okAsync(TARGET) },
    membership: {
      isActiveMember: () => okAsync(overrides.isActiveMember ?? false),
      isEpochMember: () => okAsync(overrides.isEpochMember ?? false),
    },
    shares: {
      findShare: () =>
        okAsync(
          overrides.shareCoversItem === true
            ? { revokedAt: null, expiresAt: null, contentItemIds: [ITEM_ID] }
            : null
        ),
    },
    now: () => new Date(),
  };
}

describe('presign authorization against MinIO', () => {
  let storage: Storage;

  beforeAll(async () => {
    storage = createR2Storage({
      endpoint: requireEnv('R2_S3_ENDPOINT'),
      bucket: requireEnv('R2_BUCKET_MEDIA'),
      accessKeyId: requireEnv('R2_ACCESS_KEY_ID'),
      secretAccessKey: requireEnv('R2_SECRET_ACCESS_KEY'),
      maxObjectBytes: MAX_MEDIA_OBJECT_BYTES,
      defaultPresignTtlSeconds: MEDIA_DOWNLOAD_URL_TTL_SECONDS,
      db: NO_DB,
      isCI: false,
    });
    await unwrap(storage.put(STORAGE_KEY, BYTES, { contentType: 'application/octet-stream' }));
  });

  afterAll(async () => {
    await unwrap(storage.delete(STORAGE_KEY));
  });

  it('member with epoch access fetches the bytes through the presigned URL', async () => {
    const deps = makeDeps({ isActiveMember: true, isEpochMember: true });
    const principal = { kind: 'user', userId: 'user-1' } as const;

    const { storageKey } = await unwrap(authorizePresign(principal, ITEM_ID, deps));
    const { url } = await unwrap(storage.presignGet(storageKey));

    const response = await fetch(url);
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([...BYTES]);
  });

  it('conversation member without the epoch_members row is denied', async () => {
    const deps = makeDeps({ isActiveMember: true, isEpochMember: false });
    const principal = { kind: 'user', userId: 'user-1' } as const;

    const result = await authorizePresign(principal, ITEM_ID, deps);
    expect(result._unsafeUnwrapErr().code).toBe('not_found');
  });

  it('valid shareId fetches the bytes with no membership at all', async () => {
    const deps = makeDeps({ shareCoversItem: true });
    const principal = { kind: 'share', shareId: 'share-1' } as const;

    const { storageKey } = await unwrap(authorizePresign(principal, ITEM_ID, deps));
    const { url } = await unwrap(storage.presignGet(storageKey));

    const response = await fetch(url);
    expect(response.ok).toBe(true);
  });
});
