import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { toBase64 } from '@hushbox/shared';
import { messageSharesRoute, publicSharesRoute } from './message-shares.js';
import type { AppEnv } from '../types.js';
import type { SessionData } from '../lib/session.js';
import type { MediaStorage } from '../services/storage/types.js';

// Hoisted DB mock used by the createApp() integration test below. The factory
// function is invoked lazily, so the per-test `__setRows` controls what the
// share + content_items selects return for that single request.
const dbMockState = vi.hoisted(() => ({
  rows: [] as unknown[][],
}));

vi.mock('@hushbox/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/db')>();
  /* eslint-disable unicorn/no-thenable -- mock Drizzle query builder chain */
  const createChain = (): Record<string, unknown> => {
    const chain: Record<string, unknown> = {
      from: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: () => ({
        then: (resolve: (v: unknown[]) => unknown) => {
          const next = dbMockState.rows.shift() ?? [];
          return Promise.resolve(resolve(next));
        },
      }),
      then: (resolve: (v: unknown[]) => unknown) => {
        const next = dbMockState.rows.shift() ?? [];
        return Promise.resolve(resolve(next));
      },
    };
    return chain;
  };
  /* eslint-enable unicorn/no-thenable */
  return {
    ...actual,
    createDb: vi.fn(() => ({
      select: vi.fn(() => createChain()),
    })),
    LOCAL_NEON_DEV_CONFIG: {},
  };
});

// Stub the Upstash Redis client so the per-IP rate-limit middleware in front of
// the public share GET handler can run without a real Redis instance. The
// rate-limit code only calls get/set, and a get→null→set sequence is exactly
// "first attempt in window, allowed".
vi.mock('../lib/redis.js', () => ({
  createRedisClient: vi.fn(() => ({
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
  })),
}));

const TEST_USER_ID = 'user-share-001';
const TEST_MESSAGE_ID = 'msg-share-001';
const TEST_CONVERSATION_ID = 'conv-share-001';
const TEST_SHARE_ID = 'share-001';
const TEST_WRAPPED_SHARE_KEY = new Uint8Array([10, 20, 30, 40, 50]);
const TEST_WRAPPED_SHARE_KEY_BASE64 = toBase64(TEST_WRAPPED_SHARE_KEY);
const TEST_ENCRYPTED_BLOB = new Uint8Array([60, 70, 80]);

interface ErrorBody {
  code: string;
}

function createMockSession(): SessionData {
  return {
    sessionId: `session-${TEST_USER_ID}`,
    userId: TEST_USER_ID,
    email: 'test@example.com',
    username: 'test_user',
    emailVerified: true,
    totpEnabled: false,
    hasAcknowledgedPhrase: false,
    pending2FA: false,
    pending2FAExpiresAt: 0,
    createdAt: Date.now(),
  };
}

function createMockUser(): AppEnv['Variables']['user'] {
  return {
    id: TEST_USER_ID,
    email: 'test@example.com',
    username: 'test_user',
    emailVerified: true,
    totpEnabled: false,
    hasAcknowledgedPhrase: false,
    publicKey: new Uint8Array(32),
  };
}

// ── POST /share mock infrastructure ──

interface CreateShareMockDbConfig {
  message?: { id: string; conversationId: string } | null;
  membership?: { id: string } | null;
  insertedShare?: { id: string };
}

/* eslint-disable unicorn/no-thenable -- mock Drizzle query builder chain */
function createShareMockDb(config: CreateShareMockDbConfig): unknown {
  // Pre-transaction lookup: messages.select(). Returns the message (or empty).
  // Inside-transaction lookups: SELECT membership FOR SHARE → INSERT ... RETURNING.
  let selectCallIndex = 0;
  const selectResults: unknown[][] = [
    config.message ? [config.message] : [],
    config.membership ? [config.membership] : [],
  ];

  const createQueryChain = (): Record<string, unknown> => ({
    from: () => createQueryChain(),
    where: () => createQueryChain(),
    innerJoin: () => createQueryChain(),
    leftJoin: () => createQueryChain(),
    for: () => createQueryChain(),
    limit: () => ({
      then: (resolve: (v: unknown[]) => unknown) => {
        const result = selectResults[selectCallIndex++] ?? [];
        return Promise.resolve(resolve(result));
      },
    }),
    then: (resolve: (v: unknown[]) => unknown) => {
      const result = selectResults[selectCallIndex++] ?? [];
      return Promise.resolve(resolve(result));
    },
  });

  const tx = {
    select: () => createQueryChain(),
    insert: () => ({
      values: () => ({
        returning: () => Promise.resolve([{ id: config.insertedShare?.id ?? 'new-share-id' }]),
      }),
    }),
  };

  return {
    select: () => createQueryChain(),
    insert: () => ({
      values: () => ({
        returning: () => Promise.resolve([{ id: config.insertedShare?.id ?? 'new-share-id' }]),
      }),
    }),
    transaction: <T>(callback: (tx: unknown) => Promise<T>): Promise<T> => callback(tx),
  };
}
/* eslint-enable unicorn/no-thenable */

interface CreateShareTestAppOptions {
  user?: AppEnv['Variables']['user'] | null;
  dbConfig?: CreateShareMockDbConfig;
}

/**
 * Lightweight redis stub for tests: no-op store with shape compatible with the
 * rate-limit middleware that runs before the route handler. Each test fires one
 * request, so a get→null→set sequence always passes the limit check.
 */
function createShareNoopRedis(): {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
} {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
  };
}

function createShareTestApp(options: CreateShareTestAppOptions = {}): Hono<AppEnv> {
  const { user = createMockUser(), dbConfig = {} } = options;
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    c.env = { NODE_ENV: 'development' } as unknown as AppEnv['Bindings'];
    c.set('user', user);
    c.set('session', user ? createMockSession() : null);
    c.set('sessionData', user ? createMockSession() : null);
    c.set('db', createShareMockDb(dbConfig) as AppEnv['Variables']['db']);
    c.set('redis', createShareNoopRedis() as unknown as AppEnv['Variables']['redis']);
    await next();
  });

  app.route('/', messageSharesRoute);
  return app;
}

function createShareBody(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    messageId: TEST_MESSAGE_ID,
    wrappedShareKey: TEST_WRAPPED_SHARE_KEY_BASE64,
    ...overrides,
  };
}

// ── GET /share/:shareId mock infrastructure ──

interface GetShareMockDbConfig {
  share?: {
    id: string;
    messageId: string;
    wrappedShareKey: Uint8Array;
    createdAt: Date;
  } | null;
  contentItems?: {
    id: string;
    messageId: string;
    contentType: string;
    position: number;
    encryptedBlob: Uint8Array | null;
    storageKey: string | null;
    mimeType: string | null;
    sizeBytes: number | null;
    width: number | null;
    height: number | null;
    durationMs: number | null;
    modelName: string | null;
    cost: string | null;
    isSmartModel: boolean;
  }[];
}

/* eslint-disable unicorn/no-thenable -- mock Drizzle query builder chain */
function createGetShareMockDb(config: GetShareMockDbConfig): unknown {
  let selectCallIndex = 0;

  // The public GET route does two selects:
  // 1. sharedMessages lookup (by shareId)
  // 2. contentItems lookup (by messageId)
  const selectResults: unknown[][] = [
    config.share ? [config.share] : [],
    config.contentItems ?? [],
  ];

  const createQueryChain = (): Record<string, unknown> => ({
    from: () => createQueryChain(),
    where: () => createQueryChain(),
    orderBy: () => createQueryChain(),
    limit: () => ({
      then: (resolve: (v: unknown[]) => unknown) => {
        const result = selectResults[selectCallIndex++] ?? [];
        return Promise.resolve(resolve(result));
      },
    }),
    then: (resolve: (v: unknown[]) => unknown) => {
      const result = selectResults[selectCallIndex++] ?? [];
      return Promise.resolve(resolve(result));
    },
  });

  return {
    select: () => createQueryChain(),
  };
}
/* eslint-enable unicorn/no-thenable */

interface GetShareTestAppOptions {
  user?: AppEnv['Variables']['user'] | null;
  dbConfig?: GetShareMockDbConfig;
  mediaStorage?: MediaStorage;
}

function createStubMediaStorage(overrides: Partial<MediaStorage> = {}): MediaStorage {
  const mint = vi.fn<MediaStorage['mintDownloadUrl']>((params) =>
    Promise.resolve({
      url: `https://signed.example/${params.key}`,
      expiresAt: '2026-04-19T00:05:00.000Z',
    })
  );
  return {
    put: vi.fn(() => Promise.resolve()),
    delete: vi.fn(() => Promise.resolve()),
    list: vi.fn(() => Promise.resolve({ objects: [] })),
    mintDownloadUrl: mint,
    ...overrides,
  };
}

function createGetShareTestApp(options: GetShareTestAppOptions = {}): Hono<AppEnv> {
  const { user = null, dbConfig = {}, mediaStorage = createStubMediaStorage() } = options;
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    c.env = { NODE_ENV: 'development' } as unknown as AppEnv['Bindings'];
    c.set('user', user);
    c.set('session', user ? createMockSession() : null);
    c.set('sessionData', null);
    c.set('db', createGetShareMockDb(dbConfig) as AppEnv['Variables']['db']);
    c.set('mediaStorage', mediaStorage);
    c.set('redis', createShareNoopRedis() as unknown as AppEnv['Variables']['redis']);
    await next();
  });

  app.route('/', publicSharesRoute);
  return app;
}

const defaultContentItems = [
  {
    id: 'ci-001',
    messageId: TEST_MESSAGE_ID,
    contentType: 'text',
    position: 0,
    encryptedBlob: TEST_ENCRYPTED_BLOB,
    storageKey: null,
    mimeType: null,
    sizeBytes: null,
    width: null,
    height: null,
    durationMs: null,
    modelName: null,
    cost: null,
    isSmartModel: false,
  },
];

describe('message-shares routes', () => {
  describe('POST /share (messageSharesRoute)', () => {
    it('returns 401 when not authenticated', async () => {
      const app = createShareTestApp({ user: null });

      const res = await app.request('/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createShareBody()),
      });

      expect(res.status).toBe(401);
      const body = await res.json<ErrorBody>();
      expect(body.code).toBe('NOT_AUTHENTICATED');
    });

    it('returns 404 when message not found', async () => {
      const app = createShareTestApp({
        dbConfig: {
          message: null,
        },
      });

      const res = await app.request('/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createShareBody()),
      });

      expect(res.status).toBe(404);
      const body = await res.json<ErrorBody>();
      expect(body.code).toBe('MESSAGE_NOT_FOUND');
    });

    it('returns 403 with SHARE_FORBIDDEN when user is not a member of the conversation', async () => {
      const app = createShareTestApp({
        dbConfig: {
          message: { id: TEST_MESSAGE_ID, conversationId: TEST_CONVERSATION_ID },
          membership: null,
        },
      });

      const res = await app.request('/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createShareBody()),
      });

      expect(res.status).toBe(403);
      const body = await res.json<ErrorBody & { details?: { messageId?: string } }>();
      expect(body.code).toBe('SHARE_FORBIDDEN');
      expect(body.details?.messageId).toBe(TEST_MESSAGE_ID);
    });

    it('creates share and returns 201 with shareId', async () => {
      const app = createShareTestApp({
        dbConfig: {
          message: { id: TEST_MESSAGE_ID, conversationId: TEST_CONVERSATION_ID },
          membership: { id: 'cm-001' },
          insertedShare: { id: TEST_SHARE_ID },
        },
      });

      const res = await app.request('/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createShareBody()),
      });

      expect(res.status).toBe(201);
      const body = await res.json<{ shareId: string }>();
      expect(body.shareId).toBe(TEST_SHARE_ID);
    });

    it('decodes wrappedShareKey from base64 before storing', async () => {
      let capturedValues: unknown = null;

      /* eslint-disable unicorn/no-thenable -- mock Drizzle query builder chain */
      let callIndex = 0;
      const results: unknown[][] = [
        [{ id: TEST_MESSAGE_ID, conversationId: TEST_CONVERSATION_ID }],
        [{ id: 'cm-001' }],
      ];
      const chain = (): Record<string, unknown> => ({
        from: () => chain(),
        where: () => chain(),
        for: () => chain(),
        limit: () => ({
          then: (resolve: (v: unknown[]) => unknown) => {
            const result = results[callIndex++] ?? [];
            return Promise.resolve(resolve(result));
          },
        }),
      });

      const txInsert = {
        values: (vals: unknown) => {
          capturedValues = vals;
          return {
            returning: () => Promise.resolve([{ id: 'captured-share-id' }]),
          };
        },
      };
      const tx = {
        select: () => chain(),
        insert: () => txInsert,
      };

      const mockDb = {
        select: () => chain(),
        insert: () => txInsert,
        transaction: <T>(callback: (tx: unknown) => Promise<T>): Promise<T> => callback(tx),
      };
      /* eslint-enable unicorn/no-thenable */

      const app = new Hono<AppEnv>();
      app.use('*', async (c, next) => {
        c.env = { NODE_ENV: 'development' } as unknown as AppEnv['Bindings'];
        c.set('user', createMockUser());
        c.set('session', createMockSession());
        c.set('sessionData', createMockSession());
        c.set('db', mockDb as unknown as AppEnv['Variables']['db']);
        c.set('redis', createShareNoopRedis() as unknown as AppEnv['Variables']['redis']);
        await next();
      });
      app.route('/', messageSharesRoute);

      await app.request('/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createShareBody()),
      });

      expect(capturedValues).toBeDefined();
      const values = capturedValues as { messageId: string; wrappedContentKey: Uint8Array };
      expect(values.messageId).toBe(TEST_MESSAGE_ID);
      // wrappedContentKey should be a Uint8Array, not a base64 string
      expect(values.wrappedContentKey).toBeInstanceOf(Uint8Array);
      expect(values.wrappedContentKey).toEqual(TEST_WRAPPED_SHARE_KEY);
    });
  });

  describe('GET /:shareId (publicSharesRoute)', () => {
    it('returns 404 when share not found', async () => {
      const app = createGetShareTestApp({
        dbConfig: {
          share: null,
        },
      });

      const res = await app.request(`/${TEST_SHARE_ID}`);

      expect(res.status).toBe(404);
      const body = await res.json<ErrorBody>();
      expect(body.code).toBe('SHARE_NOT_FOUND');
    });

    it('returns share data with wrappedShareKey and content items', async () => {
      const createdAt = new Date('2025-07-01T12:00:00.000Z');
      const app = createGetShareTestApp({
        dbConfig: {
          share: {
            id: TEST_SHARE_ID,
            messageId: TEST_MESSAGE_ID,
            wrappedShareKey: TEST_WRAPPED_SHARE_KEY,
            createdAt,
          },
          contentItems: defaultContentItems,
        },
      });

      const res = await app.request(`/${TEST_SHARE_ID}`);

      expect(res.status).toBe(200);
      const body = await res.json<{
        shareId: string;
        messageId: string;
        wrappedShareKey: string;
        contentItems: {
          id: string;
          contentType: string;
          position: number;
          encryptedBlob: string | null;
        }[];
        createdAt: string;
      }>();
      expect(body.shareId).toBe(TEST_SHARE_ID);
      expect(body.messageId).toBe(TEST_MESSAGE_ID);
      expect(body.wrappedShareKey).toBe(TEST_WRAPPED_SHARE_KEY_BASE64);
      expect(body.contentItems).toHaveLength(1);
      expect(body.contentItems[0]!.contentType).toBe('text');
      expect(body.createdAt).toBe('2025-07-01T12:00:00.000Z');
    });

    it('does not require authentication', async () => {
      const createdAt = new Date('2025-07-01T12:00:00.000Z');
      const app = createGetShareTestApp({
        user: null,
        dbConfig: {
          share: {
            id: TEST_SHARE_ID,
            messageId: TEST_MESSAGE_ID,
            wrappedShareKey: TEST_WRAPPED_SHARE_KEY,
            createdAt,
          },
          contentItems: defaultContentItems,
        },
      });

      const res = await app.request(`/${TEST_SHARE_ID}`);

      expect(res.status).toBe(200);
      const body = await res.json<{ shareId: string }>();
      expect(body.shareId).toBe(TEST_SHARE_ID);
    });

    it('mints a presigned downloadUrl for each media content item and strips storageKey', async () => {
      const createdAt = new Date('2025-07-01T12:00:00.000Z');
      const mintMock = vi.fn<MediaStorage['mintDownloadUrl']>((params) =>
        Promise.resolve({
          url: `https://signed.example/${params.key}?sig=abc`,
          expiresAt: '2026-04-19T00:05:00.000Z',
        })
      );
      const mediaStorage = createStubMediaStorage({ mintDownloadUrl: mintMock });

      const app = createGetShareTestApp({
        mediaStorage,
        dbConfig: {
          share: {
            id: TEST_SHARE_ID,
            messageId: TEST_MESSAGE_ID,
            wrappedShareKey: TEST_WRAPPED_SHARE_KEY,
            createdAt,
          },
          contentItems: [
            {
              id: 'ci-img',
              messageId: TEST_MESSAGE_ID,
              contentType: 'image',
              position: 0,
              encryptedBlob: null,
              storageKey: 'media/conv/msg/img-1.enc',
              mimeType: 'image/png',
              sizeBytes: 2048,
              width: 1024,
              height: 1024,
              durationMs: null,
              modelName: 'google/imagen-4',
              cost: '0.00400000',
              isSmartModel: false,
            },
            {
              id: 'ci-vid',
              messageId: TEST_MESSAGE_ID,
              contentType: 'video',
              position: 1,
              encryptedBlob: null,
              storageKey: 'media/conv/msg/vid-1.enc',
              mimeType: 'video/mp4',
              sizeBytes: 4096,
              width: 1920,
              height: 1080,
              durationMs: 5000,
              modelName: 'google/veo-3.1',
              cost: '0.50000000',
              isSmartModel: false,
            },
          ],
        },
      });

      const res = await app.request(`/${TEST_SHARE_ID}`);

      expect(res.status).toBe(200);
      const body = await res.json<{
        contentItems: {
          id: string;
          contentType: string;
          downloadUrl?: string | null;
          expiresAt?: string | null;
          storageKey?: unknown;
          modelName?: unknown;
          cost?: unknown;
          isSmartModel?: unknown;
        }[];
      }>();

      expect(mintMock).toHaveBeenCalledTimes(2);
      expect(mintMock).toHaveBeenCalledWith({ key: 'media/conv/msg/img-1.enc' });
      expect(mintMock).toHaveBeenCalledWith({ key: 'media/conv/msg/vid-1.enc' });

      const img = body.contentItems.find((item) => item.id === 'ci-img');
      const vid = body.contentItems.find((item) => item.id === 'ci-vid');
      expect(img?.downloadUrl).toBe('https://signed.example/media/conv/msg/img-1.enc?sig=abc');
      expect(img?.expiresAt).toBe('2026-04-19T00:05:00.000Z');
      expect(vid?.downloadUrl).toBe('https://signed.example/media/conv/msg/vid-1.enc?sig=abc');
      expect(vid?.expiresAt).toBe('2026-04-19T00:05:00.000Z');

      // storageKey is stripped from the public response (internal detail once downloadUrl exists).
      expect(img).not.toHaveProperty('storageKey');
      expect(vid).not.toHaveProperty('storageKey');

      // Sensitive generation metadata is stripped.
      expect(img).not.toHaveProperty('modelName');
      expect(img).not.toHaveProperty('cost');
      expect(img).not.toHaveProperty('isSmartModel');
    });

    it('does not mint a downloadUrl for text content items', async () => {
      const createdAt = new Date('2025-07-01T12:00:00.000Z');
      const mintMock = vi.fn<MediaStorage['mintDownloadUrl']>(() =>
        Promise.resolve({ url: 'should-not-be-called', expiresAt: 'x' })
      );
      const mediaStorage = createStubMediaStorage({ mintDownloadUrl: mintMock });

      const app = createGetShareTestApp({
        mediaStorage,
        dbConfig: {
          share: {
            id: TEST_SHARE_ID,
            messageId: TEST_MESSAGE_ID,
            wrappedShareKey: TEST_WRAPPED_SHARE_KEY,
            createdAt,
          },
          contentItems: defaultContentItems,
        },
      });

      const res = await app.request(`/${TEST_SHARE_ID}`);

      expect(res.status).toBe(200);
      expect(mintMock).not.toHaveBeenCalled();
      const body = await res.json<{
        contentItems: {
          contentType: string;
          downloadUrl?: string | null;
          expiresAt?: string | null;
        }[];
      }>();
      const text = body.contentItems[0]!;
      expect(text.contentType).toBe('text');
      expect(text.downloadUrl ?? null).toBeNull();
      expect(text.expiresAt ?? null).toBeNull();
    });

    it('mounts mediaStorageMiddleware on /api/shares so media items get a downloadUrl', async () => {
      // Regression: previously /api/shares/* mounted dbMiddleware + redisMiddleware
      // but NOT mediaStorageMiddleware, so c.get('mediaStorage') was undefined and
      // calling .mintDownloadUrl(...) threw at runtime. This test wires the route
      // through createApp() so the actual middleware mounting is exercised.
      const { createApp } = await import('../app.js');

      // Two selects per request: sharedMessages lookup, then contentItems lookup.
      const createdAt = new Date('2025-07-01T12:00:00.000Z');
      dbMockState.rows = [
        [
          {
            id: TEST_SHARE_ID,
            messageId: TEST_MESSAGE_ID,
            wrappedShareKey: TEST_WRAPPED_SHARE_KEY,
            createdAt,
          },
        ],
        [
          {
            id: 'ci-img',
            messageId: TEST_MESSAGE_ID,
            contentType: 'image',
            position: 0,
            encryptedBlob: null,
            storageKey: 'media/conv/msg/img-1.enc',
            mimeType: 'image/png',
            sizeBytes: 2048,
            width: 1024,
            height: 1024,
            durationMs: null,
            modelName: null,
            cost: null,
            isSmartModel: false,
          },
        ],
      ];

      const app = createApp();
      const res = await app.request(
        `/api/shares/${TEST_SHARE_ID}`,
        {},
        {
          DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
          NODE_ENV: 'development',
          UPSTASH_REDIS_REST_URL: 'http://localhost:8079',
          UPSTASH_REDIS_REST_TOKEN: 'test-token',
          R2_S3_ENDPOINT: 'http://localhost:9000',
          R2_ACCESS_KEY_ID: 'minioadmin',
          R2_SECRET_ACCESS_KEY: 'minioadmin',
          R2_BUCKET_MEDIA: 'hushbox-media-dev',
        }
      );

      expect(res.status).toBe(200);
      const body = await res.json<{
        contentItems: { id: string; downloadUrl?: string | null }[];
      }>();
      const img = body.contentItems.find((item) => item.id === 'ci-img');
      expect(img?.downloadUrl).toBeTruthy();
      expect(img?.downloadUrl).toContain('media/conv/msg/img-1.enc');
    });

    it('returns 500 with STORAGE_READ_FAILED when stored mimeType is not in the allowlist', async () => {
      const createdAt = new Date('2025-07-01T12:00:00.000Z');
      const mediaStorage = createStubMediaStorage();

      const app = createGetShareTestApp({
        mediaStorage,
        dbConfig: {
          share: {
            id: TEST_SHARE_ID,
            messageId: TEST_MESSAGE_ID,
            wrappedShareKey: TEST_WRAPPED_SHARE_KEY,
            createdAt,
          },
          contentItems: [
            {
              id: 'ci-bad',
              messageId: TEST_MESSAGE_ID,
              contentType: 'image',
              position: 0,
              encryptedBlob: null,
              storageKey: 'media/conv/msg/bad-1.enc',
              // image/gif isn't in the allowlist; serializer must throw
              mimeType: 'image/gif',
              sizeBytes: 1024,
              width: 100,
              height: 100,
              durationMs: null,
              modelName: null,
              cost: null,
              isSmartModel: false,
            },
          ],
        },
      });

      const res = await app.request(`/${TEST_SHARE_ID}`);
      expect(res.status).toBe(500);
      const body = await res.json<ErrorBody>();
      expect(body.code).toBe('STORAGE_READ_FAILED');
    });

    it('returns 500 when presigned URL minting fails', async () => {
      const createdAt = new Date('2025-07-01T12:00:00.000Z');
      const mintMock = vi.fn<MediaStorage['mintDownloadUrl']>(() =>
        Promise.reject(new Error('R2 unreachable'))
      );
      const mediaStorage = createStubMediaStorage({ mintDownloadUrl: mintMock });

      const app = createGetShareTestApp({
        mediaStorage,
        dbConfig: {
          share: {
            id: TEST_SHARE_ID,
            messageId: TEST_MESSAGE_ID,
            wrappedShareKey: TEST_WRAPPED_SHARE_KEY,
            createdAt,
          },
          contentItems: [
            {
              id: 'ci-img',
              messageId: TEST_MESSAGE_ID,
              contentType: 'image',
              position: 0,
              encryptedBlob: null,
              storageKey: 'media/conv/msg/img-1.enc',
              mimeType: 'image/png',
              sizeBytes: 2048,
              width: 1024,
              height: 1024,
              durationMs: null,
              modelName: null,
              cost: null,
              isSmartModel: false,
            },
          ],
        },
      });

      const res = await app.request(`/${TEST_SHARE_ID}`);
      expect(res.status).toBe(500);
      const body = await res.json<ErrorBody>();
      expect(body.code).toBe('STORAGE_READ_FAILED');
    });
  });
});
