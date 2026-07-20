import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createMediaStorage, type MediaStorageEnv } from './media-storage.js';
import type { MediaStorage } from './types.js';

const RUN_ID = String(Date.now());
const KEY_PREFIX = `media/integration/${RUN_ID}/`;

const R2_S3_ENDPOINT = process.env['R2_S3_ENDPOINT'];
const R2_ACCESS_KEY_ID = process.env['R2_ACCESS_KEY_ID'];
const R2_SECRET_ACCESS_KEY = process.env['R2_SECRET_ACCESS_KEY'];
const R2_BUCKET_MEDIA = process.env['R2_BUCKET_MEDIA'];

if (!R2_S3_ENDPOINT || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_MEDIA) {
  throw new Error(
    'R2 env vars (R2_S3_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_MEDIA) are required for storage integration tests — run pnpm ensure-stack from the repo root'
  );
}

const env: MediaStorageEnv = {
  R2_S3_ENDPOINT,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET_MEDIA,
};

/**
 * Direct integration test of the unified S3 codepath against a real
 * S3-compatible server. Exercises put → list → mintDownloadUrl → fetch
 * → delete to prove that aws4fetch signing, presigned URLs, and the
 * hand-rolled XML parser all work against an actual server.
 *
 * Always runs — fails fast at module load if MinIO env is missing.
 */
describe('media-storage integration (real MinIO/R2)', () => {
  let storage: MediaStorage;
  const writtenKeys: string[] = [];

  beforeAll(() => {
    storage = createMediaStorage(env);
  });

  afterAll(async () => {
    for (const key of writtenKeys) {
      try {
        await storage.delete(key);
      } catch {
        // best-effort cleanup
      }
    }
  });

  it('put writes bytes that mintDownloadUrl + fetch round-trip exactly', async () => {
    const key = `${KEY_PREFIX}round-trip.bin`;
    const expected = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    writtenKeys.push(key);

    await storage.put(key, expected, 'application/octet-stream');
    const { url } = await storage.mintDownloadUrl({ key });

    const response = await fetch(url);
    expect(response.ok).toBe(true);
    const fetched = new Uint8Array(await response.arrayBuffer());
    expect([...fetched]).toEqual([...expected]);
  });

  it('list returns the object that put just wrote, parsed from real S3 XML', async () => {
    const key = `${KEY_PREFIX}listed-object.bin`;
    const bytes = new Uint8Array(64).fill(0xab);
    writtenKeys.push(key);

    await storage.put(key, bytes, 'application/octet-stream');
    const result = await storage.list(KEY_PREFIX);

    const found = result.objects.find((o) => o.key === key);
    expect(found).toBeDefined();
    expect(found!.size).toBe(64);
    expect(found!.uploaded).toBeInstanceOf(Date);
    expect(Number.isNaN(found!.uploaded.getTime())).toBe(false);
  });

  it('delete removes the object and list no longer returns it', async () => {
    const key = `${KEY_PREFIX}deletable.bin`;
    await storage.put(key, new Uint8Array([0xff]), 'application/octet-stream');
    writtenKeys.push(key);

    await storage.delete(key);

    const result = await storage.list(KEY_PREFIX);
    const found = result.objects.find((o) => o.key === key);
    expect(found).toBeUndefined();
  });

  it('delete is idempotent — succeeds for a missing key', async () => {
    const key = `${KEY_PREFIX}never-existed.bin`;
    await expect(storage.delete(key)).resolves.toBeUndefined();
  });

  it('list paginates when more objects exist than the requested limit', async () => {
    const prefix = `${KEY_PREFIX}page/`;
    const totalObjects = 5;
    const pageLimit = 2;
    for (let index = 0; index < totalObjects; index++) {
      const key = `${prefix}${String(index)}.bin`;
      await storage.put(key, new Uint8Array([index]), 'application/octet-stream');
      writtenKeys.push(key);
    }

    let cursor: string | undefined;
    const collected: string[] = [];
    do {
      const page = await storage.list(prefix, {
        limit: pageLimit,
        ...(cursor !== undefined && { cursor }),
      });
      for (const o of page.objects) {
        collected.push(o.key);
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined);

    expect(collected).toHaveLength(totalObjects);
  });

  it('mintDownloadUrl returns an expiresAt timestamp roughly TTL from now', async () => {
    const key = `${KEY_PREFIX}ttl.bin`;
    await storage.put(key, new Uint8Array([0]), 'application/octet-stream');
    writtenKeys.push(key);

    const before = Date.now();
    const { expiresAt } = await storage.mintDownloadUrl({ key, expiresInSec: 60 });
    const after = Date.now();
    const expiryMs = new Date(expiresAt).getTime();

    expect(expiryMs).toBeGreaterThanOrEqual(before + 60_000);
    expect(expiryMs).toBeLessThanOrEqual(after + 60_000 + 1000);
  });
});
