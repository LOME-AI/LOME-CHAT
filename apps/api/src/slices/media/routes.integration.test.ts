import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Hono } from 'hono';
import { sealData } from 'iron-session';
import { ERROR_CODES, toBase64 } from '@hushbox/shared';
import { applyPipeline } from '../../middleware/pipeline.js';
import { SESSION_COOKIE_NAME } from '../../middleware/pipeline-session.js';
import { errAsync, okAsync } from '../../lib/result/index.js';
import { unavailableError } from '../../lib/errors/index.js';
import { mediaObjectKey } from './ports/index.js';
import { createScratchBucket, unwrap } from './adapters/test-fixtures.js';
import { MEDIA_RATE_LIMITS, reserveShareRemint } from './domain/index.js';
import { createMediaManifest } from './index.js';
import { Redis } from '@upstash/redis';
import type { AppEnv, Bindings } from '../../lib/context/index.js';
import type { TelemetryEnv } from '../../lib/telemetry/index.js';
import type { ScratchBucket } from './adapters/test-fixtures.js';
import type { MediaRouteDeps } from './index.js';
import type { MediaTarget, MessageShare, PresignReaders } from './ports/index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!DATABASE_URL || !UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error('DATABASE_URL and UPSTASH_REDIS_* are required for media route tests');
}

const SECRET = 'secret-at-least-32-characters-long!!';

const testEnv: Bindings & TelemetryEnv = {
  NODE_ENV: 'development',
  DATABASE_URL,
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN,
  IRON_SESSION_SECRET: SECRET,
  TELEMETRY_SINKS: 'console',
};

const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });

const grantSchema = z.object({ downloadUrl: z.string(), expiresAt: z.string() });
const errorBodySchema = z.object({ code: z.string() });

const BYTES = new Uint8Array([13, 14, 15]);
const ITEM_ID = crypto.randomUUID();
const CONVERSATION_ID = crypto.randomUUID();
const EPOCH_ID = crypto.randomUUID();
const LINK_ID = crypto.randomUUID();
const STORAGE_KEY = mediaObjectKey({
  conversationId: CONVERSATION_ID,
  messageId: crypto.randomUUID(),
  objectId: crypto.randomUUID(),
});

const MEDIA_TARGET: MediaTarget = {
  contentItemId: ITEM_ID,
  conversationId: CONVERSATION_ID,
  epochId: EPOCH_ID,
  contentType: 'image',
  storageKey: STORAGE_KEY,
};

interface ReaderConfig {
  readonly target?: MediaTarget | null;
  readonly isActiveMember?: boolean;
  readonly isEpochMember?: boolean;
  readonly share?: MessageShare | null;
}

function fakeReaders(config: ReaderConfig): PresignReaders {
  return {
    contentItems: { findMediaTarget: () => okAsync(config.target ?? MEDIA_TARGET) },
    membership: {
      isActiveMember: () => okAsync(config.isActiveMember ?? false),
      isEpochMember: () => okAsync(config.isEpochMember ?? false),
    },
    shares: { findShare: () => okAsync(config.share ?? null) },
  };
}

async function sessionCookie(overrides: { pending2FA?: boolean } = {}): Promise<string> {
  const sealed = await sealData(
    {
      userId: crypto.randomUUID(),
      sessionId: `session-${crypto.randomUUID()}`,
      createdAt: Date.now() - 1000,
      pending2FA: overrides.pending2FA ?? false,
      pending2FAExpiresAt: overrides.pending2FA === true ? Date.now() + 60_000 : 0,
    },
    { password: SECRET }
  );
  return `${SESSION_COOKIE_NAME}=${sealed}`;
}

describe('media presign routes', () => {
  let scratch: ScratchBucket;

  beforeAll(async () => {
    scratch = await createScratchBucket();
    await unwrap(
      scratch.storage.put(STORAGE_KEY, BYTES, { contentType: 'application/octet-stream' })
    );
  });

  afterAll(async () => {
    await scratch.destroy();
  });

  function createApp(readers: ReaderConfig, overrides: Partial<MediaRouteDeps> = {}): Hono<AppEnv> {
    const manifest = createMediaManifest({
      readers: () => fakeReaders(readers),
      storage: () => scratch.storage,
      linkResolution: () => ({ resolveLinkCredential: () => okAsync(null) }),
      ...overrides,
    });
    const app = applyPipeline(new Hono<AppEnv>());
    app.route(manifest.basePath, manifest.routes);
    return app;
  }

  function memberPath(contentItemId: string = ITEM_ID): string {
    return `/media/${contentItemId}/download-url`;
  }

  function sharePath(shareId: string, contentItemId: string = ITEM_ID): string {
    return `/media/shared/${shareId}/${contentItemId}/download-url`;
  }

  it('a member holding the epoch row downloads the bytes through the minted URL', async () => {
    const app = createApp({ isActiveMember: true, isEpochMember: true });

    const response = await app.request(
      memberPath(),
      { headers: { cookie: await sessionCookie() } },
      testEnv
    );

    expect(response.status).toBe(200);
    const body = grantSchema.parse(await response.json());
    expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now());
    const fetched = await fetch(body.downloadUrl);
    expect([...new Uint8Array(await fetched.arrayBuffer())]).toEqual([...BYTES]);
  });

  it('a conversation member without the epoch row is denied blind', async () => {
    const app = createApp({ isActiveMember: true, isEpochMember: false });

    const response = await app.request(
      memberPath(),
      { headers: { cookie: await sessionCookie() } },
      testEnv
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: ERROR_CODES.NOT_FOUND });
  });

  it('a non-member session is denied blind', async () => {
    const app = createApp({ isActiveMember: false });

    const response = await app.request(
      memberPath(),
      { headers: { cookie: await sessionCookie() } },
      testEnv
    );

    expect(response.status).toBe(404);
  });

  it('a caller with neither a session nor a link credential is unauthenticated', async () => {
    const app = createApp({ isActiveMember: true, isEpochMember: true });

    const response = await app.request(memberPath(), {}, testEnv);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ code: ERROR_CODES.UNAUTHORIZED });
  });

  it('a pending-2fa session is not admitted to the member path', async () => {
    const app = createApp({ isActiveMember: true, isEpochMember: true });

    const response = await app.request(
      memberPath(),
      { headers: { cookie: await sessionCookie({ pending2FA: true }) } },
      testEnv
    );

    expect(response.status).toBe(401);
  });

  it('a link guest holding the epoch row downloads through its credential', async () => {
    const app = createApp(
      { isActiveMember: true, isEpochMember: true },
      {
        linkResolution: () => ({
          resolveLinkCredential: () =>
            okAsync({ linkId: LINK_ID, conversationId: CONVERSATION_ID }),
        }),
      }
    );

    const response = await app.request(
      memberPath(),
      { headers: { 'x-link-public-key': toBase64(new Uint8Array(32).fill(7)) } },
      testEnv
    );

    expect(response.status).toBe(200);
  });

  it('a link credential that resolves to nothing is unauthenticated', async () => {
    const app = createApp({ isActiveMember: true, isEpochMember: true });

    const response = await app.request(
      memberPath(),
      { headers: { 'x-link-public-key': toBase64(new Uint8Array(32).fill(7)) } },
      testEnv
    );

    expect(response.status).toBe(401);
  });

  it('an unanswerable link store fails closed', async () => {
    const app = createApp(
      { isActiveMember: true, isEpochMember: true },
      {
        linkResolution: () => ({
          resolveLinkCredential: () => errAsync(unavailableError('store down')),
        }),
      }
    );

    const response = await app.request(
      memberPath(),
      { headers: { 'x-link-public-key': toBase64(new Uint8Array(32).fill(7)) } },
      testEnv
    );

    expect(response.status).toBe(503);
  });

  it('a non-media content item answers a validation error to an authorized member', async () => {
    const app = createApp({
      isActiveMember: true,
      isEpochMember: true,
      target: { ...MEDIA_TARGET, contentType: 'text', storageKey: null },
    });

    const response = await app.request(
      memberPath(),
      { headers: { cookie: await sessionCookie() } },
      testEnv
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: ERROR_CODES.VALIDATION });
  });

  it('a valid shareId downloads that shared message media with no authentication', async () => {
    const app = createApp({
      share: { revokedAt: null, expiresAt: null, contentItemIds: [ITEM_ID] },
    });

    const response = await app.request(sharePath(crypto.randomUUID()), {}, testEnv);

    expect(response.status).toBe(200);
    const body = grantSchema.parse(await response.json());
    const fetched = await fetch(body.downloadUrl);
    expect(fetched.ok).toBe(true);
  });

  it('a shareId is denied for a content item outside its shared message', async () => {
    const app = createApp({
      share: { revokedAt: null, expiresAt: null, contentItemIds: [crypto.randomUUID()] },
    });

    const response = await app.request(sharePath(crypto.randomUUID()), {}, testEnv);

    expect(response.status).toBe(404);
  });

  it('a revoked share is denied blind', async () => {
    const app = createApp({
      share: { revokedAt: new Date(), expiresAt: null, contentItemIds: [ITEM_ID] },
    });

    const response = await app.request(sharePath(crypto.randomUUID()), {}, testEnv);

    expect(response.status).toBe(404);
  });

  it('an expired share is denied blind', async () => {
    const app = createApp({
      share: {
        revokedAt: null,
        expiresAt: new Date(Date.now() - 1000),
        contentItemIds: [ITEM_ID],
      },
    });

    const response = await app.request(sharePath(crypto.randomUUID()), {}, testEnv);

    expect(response.status).toBe(404);
  });

  it('a Redis outage fails the share path closed', async () => {
    const app = createApp({
      share: { revokedAt: null, expiresAt: null, contentItemIds: [ITEM_ID] },
    });

    const response = await app.request(
      sharePath(crypto.randomUUID()),
      {},
      {
        ...testEnv,
        UPSTASH_REDIS_REST_URL: 'http://127.0.0.1:1',
      }
    );

    expect(response.status).toBe(503);
  });

  it('a malformed content item id is rejected at the boundary', async () => {
    const app = createApp({ isActiveMember: true, isEpochMember: true });

    const response = await app.request(
      memberPath('not-a-uuid'),
      { headers: { cookie: await sessionCookie() } },
      testEnv
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: ERROR_CODES.VALIDATION });
  });

  it('a malformed shareId is rejected at the boundary', async () => {
    const app = createApp({
      share: { revokedAt: null, expiresAt: null, contentItemIds: [ITEM_ID] },
    });

    const response = await app.request(sharePath('not-a-uuid'), {}, testEnv);

    expect(response.status).toBe(400);
  });

  it('re-mints past the per-shareId cap are rate limited', async () => {
    const app = createApp({
      share: { revokedAt: null, expiresAt: null, contentItemIds: [ITEM_ID] },
    });
    const shareId = crypto.randomUUID();
    const max = MEDIA_RATE_LIMITS.sharePresignRemintRateLimit.rateLimitConfig.maxAttempts;
    for (let attempt = 0; attempt < max; attempt += 1) {
      await unwrap(reserveShareRemint(redis, shareId));
    }

    const response = await app.request(sharePath(shareId), {}, testEnv);

    expect(response.status).toBe(429);
    const body = errorBodySchema.parse(await response.json());
    expect(body.code).toBe(ERROR_CODES.RATE_LIMITED);
  });

  it('a rate-limited caller never reaches the share lookup', async () => {
    let lookups = 0;
    const app = createApp(
      {},
      {
        readers: () => ({
          ...fakeReaders({
            share: { revokedAt: null, expiresAt: null, contentItemIds: [ITEM_ID] },
          }),
          shares: {
            findShare: () => {
              lookups += 1;
              return okAsync({ revokedAt: null, expiresAt: null, contentItemIds: [ITEM_ID] });
            },
          },
        }),
      }
    );
    const shareId = crypto.randomUUID();
    const max = MEDIA_RATE_LIMITS.sharePresignRemintRateLimit.rateLimitConfig.maxAttempts;
    for (let attempt = 0; attempt < max; attempt += 1) {
      await unwrap(reserveShareRemint(redis, shareId));
    }

    await app.request(sharePath(shareId), {}, testEnv);

    expect(lookups).toBe(0);
  });
});
