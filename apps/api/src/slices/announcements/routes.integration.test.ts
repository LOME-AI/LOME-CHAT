import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { sealData } from 'iron-session';
import { inArray } from 'drizzle-orm';
import {
  LOCAL_NEON_DEV_CONFIG,
  bannerConfig,
  bannerDismissals,
  createDb,
  users,
} from '@hushbox/db';
import { ERROR_CODES } from '@hushbox/shared';
import { applyPipeline } from '../../middleware/pipeline.js';
import { SESSION_COOKIE_NAME } from '../../middleware/pipeline-session.js';
import { createAnnouncementsManifest, createAnnouncementsStores } from './index.js';
import type { AppEnv, Bindings } from '../../lib/context/index.js';
import type { TelemetryEnv } from '../../lib/telemetry/index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for announcements route integration tests');
}

const SECRET = 'secret-at-least-32-characters-long!!';
const testEnv: Bindings & TelemetryEnv = {
  NODE_ENV: 'development',
  DATABASE_URL,
  UPSTASH_REDIS_REST_URL: 'http://localhost:8079',
  UPSTASH_REDIS_REST_TOKEN: 'token',
  IRON_SESSION_SECRET: SECRET,
  TELEMETRY_SINKS: 'console',
};

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const PREFIX = `zz${crypto.randomUUID().replaceAll('-', '').slice(0, 4)}`;
const createdUserIds: string[] = [];
const BYTES = new Uint8Array([1, 2, 3]);
let userCounter = 0;

type Variant = 'info' | 'warning' | 'critical';

async function createUser(): Promise<string> {
  userCounter += 1;
  const username = `${PREFIX}u${String(userCounter)}`;
  const rows = await db
    .insert(users)
    .values({
      email: `${username}@announcements-slice.test`,
      username,
      opaqueRegistration: BYTES,
      publicKey: BYTES,
      passwordWrappedPrivateKey: BYTES,
      recoveryWrappedPrivateKey: BYTES,
    })
    .returning({ id: users.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('user seed failed');
  createdUserIds.push(id);
  return id;
}

async function sessionCookie(userId: string): Promise<string> {
  const sealed = await sealData(
    {
      userId,
      sessionId: 'session-1',
      createdAt: Date.now() - 1000,
      pending2FA: false,
      pending2FAExpiresAt: 0,
    },
    { password: SECRET }
  );
  return `${SESSION_COOKIE_NAME}=${sealed}`;
}

function createApp(): Hono<AppEnv> {
  const manifest = createAnnouncementsManifest({ stores: createAnnouncementsStores });
  const app = applyPipeline(new Hono<AppEnv>());
  app.route(manifest.basePath, manifest.routes);
  return app;
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  return createApp().request(path, init, testEnv);
}

async function setBannerConfig(
  row: { enabled: boolean; variant: Variant; messages: unknown } | null
): Promise<void> {
  await db.delete(bannerConfig);
  if (row !== null) await db.insert(bannerConfig).values(row);
}

beforeEach(async () => {
  await db.delete(bannerConfig);
});

afterAll(async () => {
  await db.delete(bannerConfig);
  if (createdUserIds.length > 0) await db.delete(users).where(inArray(users.id, createdUserIds));
  await db.$client.end();
});

describe('GET /announcements/banner (public)', () => {
  it('returns a disabled payload (null hash) when there is no config', async () => {
    const res = await request('/announcements/banner');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, s-maxage=60');
    expect(await res.json()).toEqual({ hash: null, variant: 'info', messages: [] });
  });

  it('returns null hash when the row is disabled', async () => {
    await setBannerConfig({ enabled: false, variant: 'warning', messages: [{ text: 'hidden' }] });
    const res = await request('/announcements/banner');
    const body: { hash: string | null } = await res.json();
    expect(body.hash).toBeNull();
  });

  it('serves an enabled set with a hash and edge-cache header', async () => {
    await setBannerConfig({
      enabled: true,
      variant: 'warning',
      messages: [{ text: 'one' }, { text: 'two' }],
    });
    const res = await request('/announcements/banner');
    expect(res.headers.get('cache-control')).toBe('public, s-maxage=60');
    const body: { hash: string | null; variant: string; messages: { text: string }[] } =
      await res.json();
    expect(typeof body.hash).toBe('string');
    expect(body.hash).toHaveLength(64);
    expect(body.variant).toBe('warning');
    expect(body.messages.map((message) => message.text)).toEqual(['one', 'two']);
  });

  it('salvages invalid messages from a hand-edited row', async () => {
    await setBannerConfig({
      enabled: true,
      variant: 'info',
      messages: [{ text: 'ok' }, { text: '' }, { nope: true }],
    });
    const res = await request('/announcements/banner');
    const body: { messages: { text: string }[] } = await res.json();
    expect(body.messages.map((message) => message.text)).toEqual(['ok']);
  });
});

describe('GET|PUT /announcements/banner/dismissal (session)', () => {
  it('rejects unauthenticated reads and writes with 401', async () => {
    const read = await request('/announcements/banner/dismissal?hash=h1');
    expect(read.status).toBe(401);
    expect(await read.json()).toEqual({ code: ERROR_CODES.UNAUTHORIZED });

    const write = await request('/announcements/banner/dismissal', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hash: 'h1' }),
    });
    expect(write.status).toBe(401);
  });

  it('rejects a missing hash query with 400', async () => {
    const cookie = await sessionCookie(await createUser());
    const res = await request('/announcements/banner/dismissal', { headers: { cookie } });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: ERROR_CODES.VALIDATION });
  });

  it('reports not dismissed for a fresh user, dismissed only for the matching hash', async () => {
    const cookie = await sessionCookie(await createUser());
    const fresh = await request('/announcements/banner/dismissal?hash=hash-A', {
      headers: { cookie },
    });
    expect(await fresh.json()).toEqual({ dismissed: false });

    const put = await request('/announcements/banner/dismissal', {
      method: 'PUT',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ hash: 'hash-A' }),
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ dismissed: true });

    const matched = await request('/announcements/banner/dismissal?hash=hash-A', {
      headers: { cookie },
    });
    expect(await matched.json()).toEqual({ dismissed: true });
    const other = await request('/announcements/banner/dismissal?hash=hash-B', {
      headers: { cookie },
    });
    expect(await other.json()).toEqual({ dismissed: false });
  });

  it('keeps one row per user: a new dismissal overwrites the stored hash', async () => {
    const userId = await createUser();
    const cookie = await sessionCookie(userId);
    const putHash = async (hash: string): Promise<void> => {
      await request('/announcements/banner/dismissal', {
        method: 'PUT',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ hash }),
      });
    };
    await putHash('hash-A');
    await putHash('hash-A'); // idempotent repeat
    await putHash('hash-B'); // new set
    const rows = await db
      .select({ hash: bannerDismissals.messageSetHash })
      .from(bannerDismissals)
      .where(inArray(bannerDismissals.userId, [userId]));
    expect(rows).toEqual([{ hash: 'hash-B' }]);
  });
});
