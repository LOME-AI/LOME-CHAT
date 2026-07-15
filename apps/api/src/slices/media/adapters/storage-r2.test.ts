import { afterEach, describe, expect, it, vi } from 'vitest';
import { mediaObjectKey, stagingInputKey, stagingInputMetadata } from '../ports/index.js';
import { MAX_PRESIGN_TTL_SECONDS, createR2Storage } from './storage-r2.js';
import type { Database } from '@hushbox/db';
import type { R2StorageConfig } from './storage-r2.js';

// Offline unit tests never reach a successful S3 op, so the evidence write —
// the only db consumer — is never invoked; a stub that throws on use enforces
// that and keeps these tests free of a real connection.
const NO_DB = new Proxy(
  {},
  {
    get() {
      throw new Error('offline unit test must not touch the database');
    },
  }
) as Database;

const RUN_ID = '0190b56a-7d3e-7eee-bbbb-0123456789ab';
const OBJECT_ID = '0190b56a-7d3e-7ddd-bbbb-0123456789ab';
const MEDIA_KEY = mediaObjectKey({
  conversationId: '0190b56a-7d3e-7aaa-bbbb-0123456789ab',
  messageId: '0190b56a-7d3e-7ccc-bbbb-0123456789ab',
  objectId: OBJECT_ID,
});

/** Unreachable endpoint: any test that hits the network fails loudly. */
function offlineConfig(overrides: Partial<R2StorageConfig> = {}): R2StorageConfig {
  return {
    endpoint: 'http://127.0.0.1:9',
    bucket: 'unit-test-bucket',
    accessKeyId: 'unit-test-key',
    secretAccessKey: 'unit-test-secret',
    maxObjectBytes: 64,
    defaultPresignTtlSeconds: 123,
    db: NO_DB,
    isCI: false,
    network: { maxRetries: 0, initialDelayMs: 1, maxDelayMs: 1, timeoutMs: 1000 },
    ...overrides,
  };
}

describe('createR2Storage config validation', () => {
  it.each(['endpoint', 'bucket', 'accessKeyId', 'secretAccessKey'] as const)(
    'throws when %s is empty',
    (field) => {
      expect(() => createR2Storage(offlineConfig({ [field]: '' }))).toThrow(field);
    }
  );

  it.each(['maxObjectBytes', 'defaultPresignTtlSeconds'] as const)(
    'throws when %s is not a positive integer',
    (field) => {
      expect(() => createR2Storage(offlineConfig({ [field]: 0 }))).toThrow(field);
    }
  );
});

describe('put validation', () => {
  it('rejects bytes over the configured size cap with a validation error', async () => {
    const storage = createR2Storage(offlineConfig({ maxObjectBytes: 8 }));
    const result = await storage.put('media/too-big', new Uint8Array(9), {
      contentType: 'application/octet-stream',
    });
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('rejects an inputs/ key without run-binding metadata before any network call', async () => {
    const storage = createR2Storage(offlineConfig());
    const key = stagingInputKey({ runId: RUN_ID, objectId: OBJECT_ID });
    const result = await storage.put(key, new Uint8Array([1]), {
      contentType: 'application/octet-stream',
    });
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('rejects an inputs/ key whose bound runId mismatches the key', async () => {
    const storage = createR2Storage(offlineConfig());
    const key = stagingInputKey({ runId: RUN_ID, objectId: OBJECT_ID });
    const metadata = stagingInputMetadata({ runId: OBJECT_ID, objectId: OBJECT_ID });
    const result = await storage.put(key, new Uint8Array([1]), {
      contentType: 'application/octet-stream',
      metadata,
    });
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it.each([
    ['non-uuid segment', 'media/not-a-uuid'],
    ['missing segments', `media/${RUN_ID}/${OBJECT_ID}`],
    ['extra segment', `${MEDIA_KEY}/${OBJECT_ID}`],
  ])('rejects a media/ key with %s before any network call', async (_label, key) => {
    const storage = createR2Storage(offlineConfig());
    const result = await storage.put(key, new Uint8Array([1]), {
      contentType: 'application/octet-stream',
    });
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });
});

describe('put media mime allowlist', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects a mediaMimeType outside the allowlist with a validation error and no network call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const storage = createR2Storage(offlineConfig());

    const result = await storage.put(MEDIA_KEY, new Uint8Array([1]), {
      contentType: 'application/octet-stream',
      mediaMimeType: 'application/x-not-allowed',
    });

    expect(result._unsafeUnwrapErr().code).toBe('validation');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts a mediaMimeType inside the allowlist and writes normally', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const storage = createR2Storage(offlineConfig());

    const result = await storage.put(MEDIA_KEY, new Uint8Array([1]), {
      contentType: 'application/octet-stream',
      mediaMimeType: 'image/png',
    });

    expect(result.isOk()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('omitting mediaMimeType preserves current behavior and reaches the network', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const storage = createR2Storage(offlineConfig());

    const result = await storage.put(MEDIA_KEY, new Uint8Array([1]), {
      contentType: 'application/octet-stream',
    });

    expect(result.isOk()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('malformed upstream responses', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('maps a non-ok response whose error body cannot be read to unavailable', async () => {
    // A real errored ReadableStream body hangs Response#text under the test
    // runner, so the read failure is injected at the method instead.
    const broken = new Response('ignored', { status: 500 });
    Object.defineProperty(broken, 'text', {
      value: (): Promise<string> => Promise.reject(new Error('body stream failed')),
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(broken));
    const storage = createR2Storage(offlineConfig());

    const result = await storage.put(MEDIA_KEY, new Uint8Array([1]), {
      contentType: 'application/octet-stream',
    });

    const error = result._unsafeUnwrapErr();
    expect(error.code).toBe('unavailable');
    expect((error.cause as Error).message).toContain('<unreadable body>');
  });

  it('maps a HEAD response without a content-length to unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
    const storage = createR2Storage(offlineConfig());

    const result = await storage.head('media/key');

    const error = result._unsafeUnwrapErr();
    expect(error.code).toBe('unavailable');
    expect((error.cause as Error).message).toContain('content-length');
  });

  it('maps a HEAD response without a last-modified to unavailable', async () => {
    const headers = { 'content-length': '3' };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200, headers })));
    const storage = createR2Storage(offlineConfig());

    const result = await storage.head('media/key');

    const error = result._unsafeUnwrapErr();
    expect(error.code).toBe('unavailable');
    expect((error.cause as Error).message).toContain('last-modified');
  });
});

describe('retry seam', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('makes exactly one network attempt on a 5xx response', async () => {
    // aws4fetch defaults to 10 internal retries with backoff on 5xx/429; the
    // policy factory is the single retry seam, so the client must be built
    // with retries: 0. This pins that — one 5xx, one fetch call.
    const fetchMock = vi.fn().mockResolvedValue(new Response('server error', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    const storage = createR2Storage(offlineConfig());

    const result = await storage.head('media/key');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });
});

describe('presignGet', () => {
  it('rejects a non-positive expiry with a validation error', async () => {
    const storage = createR2Storage(offlineConfig());
    const result = await storage.presignGet('media/key', { expiresInSec: 0 });
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('rejects an expiry above the presign TTL ceiling with a validation error', async () => {
    const storage = createR2Storage(offlineConfig());
    const result = await storage.presignGet('media/key', {
      expiresInSec: MAX_PRESIGN_TTL_SECONDS + 1,
    });
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('accepts an expiry exactly at the presign TTL ceiling', async () => {
    const storage = createR2Storage(offlineConfig());
    const result = await storage.presignGet('media/key', { expiresInSec: MAX_PRESIGN_TTL_SECONDS });
    expect(result._unsafeUnwrap().url).toContain(
      `X-Amz-Expires=${String(MAX_PRESIGN_TTL_SECONDS)}`
    );
  });

  it('defaults the expiry to the configured presign TTL', async () => {
    const storage = createR2Storage(offlineConfig({ defaultPresignTtlSeconds: 123 }));
    const result = await storage.presignGet('media/key');
    expect(result._unsafeUnwrap().url).toContain('X-Amz-Expires=123');
  });

  it('returns an expiresAt roughly ttl seconds from now', async () => {
    const storage = createR2Storage(offlineConfig());
    const before = Date.now();
    const result = await storage.presignGet('media/key', { expiresInSec: 60 });
    const after = Date.now();
    const expiresAt = result._unsafeUnwrap().expiresAt.getTime();
    expect(expiresAt).toBeGreaterThanOrEqual(before + 60_000);
    expect(expiresAt).toBeLessThanOrEqual(after + 60_000);
  });

  it('maps a signing failure to an unavailable error', async () => {
    const storage = createR2Storage(offlineConfig({ endpoint: 'http://[invalid-endpoint' }));
    const result = await storage.presignGet('media/key');
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });
});
