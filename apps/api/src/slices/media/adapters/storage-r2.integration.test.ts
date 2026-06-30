import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_MEDIA_OBJECT_BYTES, MEDIA_DOWNLOAD_URL_TTL_SECONDS } from '@hushbox/shared';
import {
  STAGING_REF_METADATA_KEY,
  STAGING_RUN_ID_METADATA_KEY,
  mediaObjectKey,
  stagingInputKey,
  stagingInputMetadata,
} from '../ports/index.js';
import { createR2Storage } from './storage-r2.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { Storage } from '../ports/index.js';
import type { R2StorageConfig } from './storage-r2.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required for storage integration tests — run via pnpm test:api`);
  }
  return value;
}

const CONFIG: R2StorageConfig = {
  endpoint: requireEnv('R2_S3_ENDPOINT'),
  bucket: requireEnv('R2_BUCKET_MEDIA'),
  accessKeyId: requireEnv('R2_ACCESS_KEY_ID'),
  secretAccessKey: requireEnv('R2_SECRET_ACCESS_KEY'),
  maxObjectBytes: MAX_MEDIA_OBJECT_BYTES,
  defaultPresignTtlSeconds: MEDIA_DOWNLOAD_URL_TTL_SECONDS,
};

const CONVERSATION_ID = crypto.randomUUID();
const OCTET_STREAM = 'application/octet-stream';

async function unwrap<T>(result: ResultAsync<T, DomainError>): Promise<T> {
  const settled = await result;
  return settled._unsafeUnwrap();
}

async function unwrapErr<T>(result: ResultAsync<T, DomainError>): Promise<DomainError> {
  const settled = await result;
  return settled._unsafeUnwrapErr();
}

function newMediaKey(): string {
  return mediaObjectKey({
    conversationId: CONVERSATION_ID,
    messageId: crypto.randomUUID(),
    objectId: crypto.randomUUID(),
  });
}

describe('storage-r2 MinIO parity', () => {
  let storage: Storage;
  const writtenKeys: string[] = [];

  beforeAll(() => {
    storage = createR2Storage(CONFIG);
  });

  afterAll(async () => {
    for (const key of writtenKeys) {
      await unwrap(storage.delete(key));
    }
  });

  it('round-trips bytes through put, presignGet, and fetch', async () => {
    const key = newMediaKey();
    writtenKeys.push(key);
    const expected = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    await unwrap(storage.put(key, expected, { contentType: OCTET_STREAM }));
    const { url } = await unwrap(storage.presignGet(key));

    const response = await fetch(url);
    expect(response.ok).toBe(true);
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([...expected]);
  });

  it('double-put of the same key and bytes yields exactly one object', async () => {
    const key = newMediaKey();
    writtenKeys.push(key);
    const bytes = new Uint8Array(32).fill(0x5a);

    await unwrap(storage.put(key, bytes, { contentType: OCTET_STREAM }));
    await unwrap(storage.put(key, bytes, { contentType: OCTET_STREAM }));

    const page = await unwrap(storage.list(key));
    expect(page.objects.map((o) => o.key)).toEqual([key]);
    expect(page.objects[0]?.size).toBe(32);
  });

  it('staging put stores the run-binding metadata readable via head', async () => {
    const location = { runId: crypto.randomUUID(), objectId: crypto.randomUUID() };
    const key = stagingInputKey(location);
    writtenKeys.push(key);

    await unwrap(
      storage.put(key, new Uint8Array([7]), {
        contentType: OCTET_STREAM,
        metadata: stagingInputMetadata(location),
      })
    );

    const stat = await unwrap(storage.head(key));
    expect(stat?.metadata[STAGING_RUN_ID_METADATA_KEY]).toBe(location.runId);
    expect(stat?.metadata[STAGING_REF_METADATA_KEY]).toBe(key);
  });

  it('head reports size and a real uploaded date', async () => {
    const key = newMediaKey();
    writtenKeys.push(key);
    await unwrap(storage.put(key, new Uint8Array(16), { contentType: OCTET_STREAM }));

    const stat = await unwrap(storage.head(key));
    expect(stat?.size).toBe(16);
    expect(Number.isNaN(stat?.uploaded.getTime())).toBe(false);
  });

  it('head resolves null for a missing key', async () => {
    const stat = await unwrap(storage.head(newMediaKey()));
    expect(stat).toBeNull();
  });

  it('delete removes the object', async () => {
    const key = newMediaKey();
    await unwrap(storage.put(key, new Uint8Array([1]), { contentType: OCTET_STREAM }));

    await unwrap(storage.delete(key));

    expect(await unwrap(storage.head(key))).toBeNull();
  });

  it('delete succeeds for a key that never existed', async () => {
    const result = await storage.delete(newMediaKey());
    expect(result.isOk()).toBe(true);
  });

  it('list paginates with a cursor until exhausted', async () => {
    const messageId = crypto.randomUUID();
    const prefix = `media/${CONVERSATION_ID}/${messageId}/`;
    const total = 5;
    for (let index = 0; index < total; index++) {
      const key = mediaObjectKey({
        conversationId: CONVERSATION_ID,
        messageId,
        objectId: crypto.randomUUID(),
      });
      writtenKeys.push(key);
      await unwrap(storage.put(key, new Uint8Array([index]), { contentType: OCTET_STREAM }));
    }

    const collected: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await unwrap(
        storage.list(prefix, { limit: 2, ...(cursor !== undefined && { cursor }) })
      );
      collected.push(...page.objects.map((o) => o.key));
      cursor = page.nextCursor;
    } while (cursor !== undefined);

    expect(collected).toHaveLength(total);
  });

  it('presigned URL stops being honored after its expiry', async () => {
    const key = newMediaKey();
    writtenKeys.push(key);
    await unwrap(storage.put(key, new Uint8Array([1]), { contentType: OCTET_STREAM }));

    const { url } = await unwrap(storage.presignGet(key, { expiresInSec: 1 }));

    // Clock-based, flake-safe: poll until the server rejects, bounded by a
    // deadline far past the 1s expiry instead of sleeping a fixed interval.
    const deadline = Date.now() + 10_000;
    let lastStatus = 0;
    for (;;) {
      const response = await fetch(url);
      lastStatus = response.status;
      if (!response.ok || Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(lastStatus).toBe(403);
  }, 15_000);
});

describe('storage-r2 upstream failures', () => {
  const fastNetwork = { maxRetries: 0, initialDelayMs: 1, maxDelayMs: 1, timeoutMs: 5000 };

  it('put to a nonexistent bucket maps to unavailable', async () => {
    const storage = createR2Storage({
      ...CONFIG,
      bucket: 'hushbox-no-such-bucket',
      network: fastNetwork,
    });
    const error = await unwrapErr(
      storage.put(newMediaKey(), new Uint8Array([1]), { contentType: OCTET_STREAM })
    );
    expect(error.code).toBe('unavailable');
  });

  it('list on a nonexistent bucket maps to unavailable', async () => {
    const storage = createR2Storage({
      ...CONFIG,
      bucket: 'hushbox-no-such-bucket',
      network: fastNetwork,
    });
    const error = await unwrapErr(storage.list('media/'));
    expect(error.code).toBe('unavailable');
  });

  it('delete on a nonexistent bucket maps to unavailable', async () => {
    const storage = createR2Storage({
      ...CONFIG,
      bucket: 'hushbox-no-such-bucket',
      network: fastNetwork,
    });
    const error = await unwrapErr(storage.delete(newMediaKey()));
    expect(error.code).toBe('unavailable');
  });

  it('head with bad credentials maps to unavailable', async () => {
    const storage = createR2Storage({
      ...CONFIG,
      secretAccessKey: 'wrong-secret',
      network: fastNetwork,
    });
    const error = await unwrapErr(storage.head(newMediaKey()));
    expect(error.code).toBe('unavailable');
  });
});
