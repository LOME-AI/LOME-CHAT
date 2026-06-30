import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { mediaRoute } from './media.js';
import type { AppEnv } from '../types.js';
import type { SessionData } from '../lib/session.js';
import type { MediaStorage } from '../services/storage/index.js';

/**
 * Lightweight redis stub: no-op store with a shape compatible with the rate-limit
 * middleware that runs ahead of the route handler. The rate-limit middleware
 * calls redis.get → null → redis.set, which both no-op here, so a single test
 * request always passes the limit check.
 */
function createNoopRedis(): {
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

const TEST_USER_ID = 'user-media-001';
const TEST_CONTENT_ITEM_ID = 'ci-media-001';
const TEST_CONVERSATION_ID = 'conv-media-001';
const TEST_STORAGE_KEY = 'media/conv-media-001/msg-media-001/ci-media-001.enc';

interface ErrorBody {
  code: string;
}

async function jsonBody<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function createMockSession(): SessionData {
  return {
    sessionId: `session-${TEST_USER_ID}`,
    userId: TEST_USER_ID,
    email: 'media@example.com',
    username: 'media_user',
    emailVerified: true,
    totpEnabled: false,
    hasAcknowledgedPhrase: true,
    pending2FA: false,
    pending2FAExpiresAt: 0,
    createdAt: Date.now(),
  };
}

function createMockUser(): AppEnv['Variables']['user'] {
  return {
    id: TEST_USER_ID,
    email: 'media@example.com',
    username: 'media_user',
    emailVerified: true,
    totpEnabled: false,
    hasAcknowledgedPhrase: true,
    publicKey: new Uint8Array(32),
  };
}

interface MediaRowShape {
  id: string;
  contentType: 'text' | 'image' | 'audio' | 'video';
  storageKey: string | null;
  conversationId: string;
}

interface MediaMockDbConfig {
  row?: MediaRowShape | null;
}

/* eslint-disable unicorn/no-thenable -- mock Drizzle query builder chain */
function createMediaMockDb(config: MediaMockDbConfig): unknown {
  const result = config.row ? [config.row] : [];

  const createQueryChain = (): Record<string, unknown> => ({
    from: () => createQueryChain(),
    innerJoin: () => createQueryChain(),
    leftJoin: () => createQueryChain(),
    where: () => createQueryChain(),
    limit: () => ({
      then: (resolve: (v: unknown[]) => unknown) => Promise.resolve(resolve(result)),
    }),
    then: (resolve: (v: unknown[]) => unknown) => Promise.resolve(resolve(result)),
  });

  return {
    select: () => createQueryChain(),
  };
}
/* eslint-enable unicorn/no-thenable */

interface FakeStorage extends Pick<MediaStorage, 'mintDownloadUrl'> {
  mintedFor: string[];
}

function createFakeStorage(options: { fail?: boolean } = {}): FakeStorage {
  const minted: string[] = [];
  return {
    mintedFor: minted,
    mintDownloadUrl: ({ key }) => {
      minted.push(key);
      if (options.fail) return Promise.reject(new Error('mint-fail'));
      return Promise.resolve({
        url: `https://presigned.example/${key}?sig=xyz`,
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      });
    },
  };
}

interface TestAppOptions {
  user?: AppEnv['Variables']['user'] | null;
  dbConfig?: MediaMockDbConfig;
  storage?: FakeStorage;
}

function createMediaTestApp(options: TestAppOptions = {}): {
  app: Hono<AppEnv>;
  storage: FakeStorage;
} {
  const { user = createMockUser(), dbConfig = {}, storage = createFakeStorage() } = options;
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    c.env = { NODE_ENV: 'development' } as unknown as AppEnv['Bindings'];
    c.set('user', user);
    c.set('session', user ? createMockSession() : null);
    c.set('sessionData', user ? createMockSession() : null);
    c.set('db', createMediaMockDb(dbConfig) as AppEnv['Variables']['db']);
    c.set('mediaStorage', storage as unknown as MediaStorage);
    c.set('redis', createNoopRedis() as unknown as AppEnv['Variables']['redis']);
    await next();
  });

  app.route('/', mediaRoute);
  return { app, storage };
}

describe('mediaRoute GET /:contentItemId/download-url', () => {
  it('returns 401 when not authenticated', async () => {
    const { app } = createMediaTestApp({ user: null });

    const res = await app.request(`/${TEST_CONTENT_ITEM_ID}/download-url`);

    expect(res.status).toBe(401);
  });

  it('returns 404 when the content item does not exist', async () => {
    const { app } = createMediaTestApp({ dbConfig: { row: null } });

    const res = await app.request(`/${TEST_CONTENT_ITEM_ID}/download-url`);

    expect(res.status).toBe(404);
    const body = await jsonBody<ErrorBody>(res);
    expect(body.code).toBe('CONTENT_ITEM_NOT_FOUND');
  });

  it('returns 404 when the caller is not a conversation member', async () => {
    // The db query joins conversation_members with userId = caller.id; if the
    // caller is not a member, the query returns zero rows — same as missing.
    const { app } = createMediaTestApp({ dbConfig: { row: null } });

    const res = await app.request(`/${TEST_CONTENT_ITEM_ID}/download-url`);

    expect(res.status).toBe(404);
    const body = await jsonBody<ErrorBody>(res);
    expect(body.code).toBe('CONTENT_ITEM_NOT_FOUND');
  });

  it("rejects download URL for media from an epoch the user wasn't in", async () => {
    // Regression: previously the route only verified conversation membership.
    // A late-joiner could mint download URLs for ciphertext from earlier
    // epochs they were never part of (cannot decrypt, but exfiltrates blobs).
    // The fixed query JOINs epoch_members on (memberPublicKey = user.publicKey,
    // epochId from the message's epoch_number) so non-epoch-members get zero
    // rows and a blind 404.
    //
    // We model this with a mock that captures the JOIN clauses: the test
    // asserts the db chain receives BOTH innerJoin calls (one for
    // conversation_members, one for epoch_members) before the route resolves,
    // and that an empty result set surfaces as 404.
    let innerJoinCallCount = 0;
    /* eslint-disable unicorn/no-thenable */
    const createCountingChain = (): Record<string, unknown> => ({
      from: () => createCountingChain(),
      innerJoin: (..._args: unknown[]) => {
        innerJoinCallCount += 1;
        return createCountingChain();
      },
      leftJoin: () => createCountingChain(),
      where: () => createCountingChain(),
      limit: () => ({
        then: (resolve: (v: unknown[]) => unknown) => Promise.resolve(resolve([])),
      }),
      then: (resolve: (v: unknown[]) => unknown) => Promise.resolve(resolve([])),
    });
    /* eslint-enable unicorn/no-thenable */
    const countingDb = { select: () => createCountingChain() } as unknown;

    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.env = { NODE_ENV: 'development' } as unknown as AppEnv['Bindings'];
      c.set('user', createMockUser());
      c.set('session', createMockSession());
      c.set('sessionData', createMockSession());
      c.set('db', countingDb as AppEnv['Variables']['db']);
      c.set('mediaStorage', createFakeStorage() as unknown as MediaStorage);
      c.set('redis', createNoopRedis() as unknown as AppEnv['Variables']['redis']);
      await next();
    });
    app.route('/', mediaRoute);

    const res = await app.request(`/${TEST_CONTENT_ITEM_ID}/download-url`);

    expect(res.status).toBe(404);
    const body = await jsonBody<ErrorBody>(res);
    expect(body.code).toBe('CONTENT_ITEM_NOT_FOUND');
    // Three inner joins: messages, conversation_members, epoch_members
    // (epochs is also joined to resolve epoch_id from epoch_number).
    expect(innerJoinCallCount).toBeGreaterThanOrEqual(3);
  });

  it('returns 400 when the content item is text (not downloadable)', async () => {
    const { app } = createMediaTestApp({
      dbConfig: {
        row: {
          id: TEST_CONTENT_ITEM_ID,
          contentType: 'text',
          storageKey: null,
          conversationId: TEST_CONVERSATION_ID,
        },
      },
    });

    const res = await app.request(`/${TEST_CONTENT_ITEM_ID}/download-url`);

    expect(res.status).toBe(400);
    const body = await jsonBody<ErrorBody>(res);
    expect(body.code).toBe('CONTENT_ITEM_NOT_MEDIA');
  });

  it('returns 200 with downloadUrl and expiresAt for an image content item', async () => {
    const { app, storage } = createMediaTestApp({
      dbConfig: {
        row: {
          id: TEST_CONTENT_ITEM_ID,
          contentType: 'image',
          storageKey: TEST_STORAGE_KEY,
          conversationId: TEST_CONVERSATION_ID,
        },
      },
    });

    const res = await app.request(`/${TEST_CONTENT_ITEM_ID}/download-url`);

    expect(res.status).toBe(200);
    const body = await jsonBody<{ downloadUrl: string; expiresAt: string }>(res);
    expect(body.downloadUrl).toContain(TEST_STORAGE_KEY);
    expect(new Date(body.expiresAt).toString()).not.toBe('Invalid Date');
    expect(storage.mintedFor).toEqual([TEST_STORAGE_KEY]);
  });

  it('returns 200 for video content items', async () => {
    const { app } = createMediaTestApp({
      dbConfig: {
        row: {
          id: TEST_CONTENT_ITEM_ID,
          contentType: 'video',
          storageKey: TEST_STORAGE_KEY,
          conversationId: TEST_CONVERSATION_ID,
        },
      },
    });

    const res = await app.request(`/${TEST_CONTENT_ITEM_ID}/download-url`);

    expect(res.status).toBe(200);
  });

  it('returns 200 for audio content items', async () => {
    const { app } = createMediaTestApp({
      dbConfig: {
        row: {
          id: TEST_CONTENT_ITEM_ID,
          contentType: 'audio',
          storageKey: TEST_STORAGE_KEY,
          conversationId: TEST_CONVERSATION_ID,
        },
      },
    });

    const res = await app.request(`/${TEST_CONTENT_ITEM_ID}/download-url`);

    expect(res.status).toBe(200);
  });

  it('returns 200 for a link guest who is an active member with epoch access', async () => {
    // Link guests authenticate via the `x-link-public-key` header. The route
    // must accept this identity in addition to session users, and join the
    // authorization query on `conversationMembers.linkId` + the link's
    // publicKey in `epochMembers`. Mirrors the access path used by
    // /api/conversations/:id for link-guest reads.
    const LINK_ID = 'link-001';
    const LINK_PUBLIC_KEY_B64 = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'; // 32 bytes base64
    /* eslint-disable unicorn/no-thenable */
    const createQueryChain = (rows: unknown[]): Record<string, unknown> => ({
      from: () => createQueryChain(rows),
      innerJoin: () => createQueryChain(rows),
      leftJoin: () => createQueryChain(rows),
      where: () => createQueryChain(rows),
      limit: () => ({
        then: (resolve: (v: unknown[]) => unknown) => Promise.resolve(resolve(rows)),
      }),
      then: (resolve: (v: unknown[]) => unknown) => Promise.resolve(resolve(rows)),
    });
    /* eslint-enable unicorn/no-thenable */

    // resolveLinkGuest queries sharedLinks then conversationMembers — we satisfy
    // both with a select() that returns rows shaped for whichever caller is
    // asking. The media query itself comes last and gets the row config.
    let selectCallCount = 0;
    const linkRow = {
      id: LINK_ID,
      conversationId: TEST_CONVERSATION_ID,
      displayName: 'Guest 1',
      revokedAt: null,
    };
    const memberRow = {
      id: 'cm-link-001',
      privilege: 'read',
      visibleFromEpoch: 1,
    };
    const mediaRow = {
      id: TEST_CONTENT_ITEM_ID,
      contentType: 'image' as const,
      storageKey: TEST_STORAGE_KEY,
      conversationId: TEST_CONVERSATION_ID,
    };
    const db = {
      select: () => {
        selectCallCount += 1;
        // Order: 1) shared link lookup, 2) link-member lookup, 3) media query
        if (selectCallCount === 1) return createQueryChain([linkRow]);
        if (selectCallCount === 2) return createQueryChain([memberRow]);
        return createQueryChain([mediaRow]);
      },
    };

    const storage = createFakeStorage();
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.env = { NODE_ENV: 'development' } as unknown as AppEnv['Bindings'];
      c.set('user', null);
      c.set('session', null);
      c.set('sessionData', null);
      c.set('db', db as unknown as AppEnv['Variables']['db']);
      c.set('mediaStorage', storage as unknown as MediaStorage);
      c.set('redis', createNoopRedis() as unknown as AppEnv['Variables']['redis']);
      await next();
    });
    app.route('/', mediaRoute);

    const res = await app.request(`/${TEST_CONTENT_ITEM_ID}/download-url`, {
      headers: { 'x-link-public-key': LINK_PUBLIC_KEY_B64 },
    });

    expect(res.status).toBe(200);
    const body = await jsonBody<{ downloadUrl: string; expiresAt: string }>(res);
    expect(body.downloadUrl).toContain(TEST_STORAGE_KEY);
    expect(storage.mintedFor).toEqual([TEST_STORAGE_KEY]);
  });

  it('returns 401 for a link guest whose public key does not match any active link', async () => {
    const LINK_PUBLIC_KEY_B64 = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const { app } = createMediaTestApp({ user: null, dbConfig: { row: null } });

    const res = await app.request(`/${TEST_CONTENT_ITEM_ID}/download-url`, {
      headers: { 'x-link-public-key': LINK_PUBLIC_KEY_B64 },
    });

    expect(res.status).toBe(401);
  });

  it('returns 500 with STORAGE_READ_FAILED when minting fails', async () => {
    const storage = createFakeStorage({ fail: true });
    const { app } = createMediaTestApp({
      storage,
      dbConfig: {
        row: {
          id: TEST_CONTENT_ITEM_ID,
          contentType: 'image',
          storageKey: TEST_STORAGE_KEY,
          conversationId: TEST_CONVERSATION_ID,
        },
      },
    });

    const res = await app.request(`/${TEST_CONTENT_ITEM_ID}/download-url`);

    expect(res.status).toBe(500);
    const body = await jsonBody<ErrorBody>(res);
    expect(body.code).toBe('STORAGE_READ_FAILED');
  });
});
