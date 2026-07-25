import { describe, it, expect, afterAll } from 'vitest';
import { Hono } from 'hono';
import { sealData } from 'iron-session';
import { eq, inArray } from 'drizzle-orm';
import { createDb, deviceTokens, LOCAL_NEON_DEV_CONFIG, users } from '@hushbox/db';
import { placeholderBytes } from '@hushbox/db/factories';
import { applyPipeline } from '../../middleware/pipeline.js';
import { errAsync } from '../../lib/result/index.js';
import { unavailableError } from '../../lib/errors/index.js';
import { createDeviceTokenStore } from './adapters/device-token-store-db.js';
import { createNotificationPreferencesStore } from './adapters/notification-preferences-store-db.js';
import { createNotificationsManifest } from './routes.js';
import type { AppEnv, Bindings } from '../../lib/context/index.js';
import type { TelemetryEnv } from '../../lib/telemetry/index.js';
import type { DeviceTokenStore, NotificationPreferencesStore } from './ports/index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for notifications integration tests');
}

const SECRET = 'secret-at-least-32-characters-long!!';
const SESSION_COOKIE_NAME = 'hushbox_session';

const env: Bindings & TelemetryEnv = {
  NODE_ENV: 'development',
  DATABASE_URL,
  UPSTASH_REDIS_REST_URL: 'http://localhost:8079',
  UPSTASH_REDIS_REST_TOKEN: 'token',
  IRON_SESSION_SECRET: SECRET,
  TELEMETRY_SINKS: 'console',
};

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });

// Mirrors the app assembly: the one default-deny pipeline, then the slice
// manifest at its real path.
const manifest = createNotificationsManifest({
  deviceTokenStore: createDeviceTokenStore,
  preferencesStore: createNotificationPreferencesStore,
});
const app = applyPipeline(new Hono<AppEnv>()).route(manifest.basePath, manifest.routes);

const createdUserIds: string[] = [];

async function createUser(): Promise<string> {
  const suffix = crypto.randomUUID().slice(0, 13);
  const [row] = await db
    .insert(users)
    .values({
      email: `routes-${suffix}@test.hushbox.ai`,
      username: `rt-${suffix}`,
      opaqueRegistration: placeholderBytes(32),
      publicKey: placeholderBytes(32),
      passwordWrappedPrivateKey: placeholderBytes(32),
      recoveryWrappedPrivateKey: placeholderBytes(32),
    })
    .returning({ id: users.id });
  if (row === undefined) throw new Error('user insert returned no row');
  createdUserIds.push(row.id);
  return row.id;
}

async function sessionCookieFor(userId: string): Promise<string> {
  const sealed = await sealData(
    {
      userId,
      sessionId: crypto.randomUUID(),
      createdAt: Date.now() - 1000,
      pending2FA: false,
      pending2FAExpiresAt: 0,
    },
    { password: SECRET }
  );
  return `${SESSION_COOKIE_NAME}=${sealed}`;
}

function registerRequest(cookie: string | undefined, body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: JSON.stringify(body),
  };
}

async function tokenRowCount(token: string): Promise<number> {
  const rows = await db.select().from(deviceTokens).where(eq(deviceTokens.token, token));
  return rows.length;
}

function freshToken(): string {
  return `route-token-${crypto.randomUUID()}`;
}

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db.$client.end();
});

describe('POST /notifications/device-tokens', () => {
  it('denies an anonymous request through the pipeline', async () => {
    const res = await app.request(
      '/notifications/device-tokens',
      registerRequest(undefined, { token: freshToken(), platform: 'ios' }),
      env
    );

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: 'UNAUTHORIZED' });
  });

  it('registers a device token for the session user', async () => {
    const userId = await createUser();
    const cookie = await sessionCookieFor(userId);
    const token = freshToken();

    const res = await app.request(
      '/notifications/device-tokens',
      registerRequest(cookie, { token, platform: 'ios' }),
      env
    );

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ registered: true });
    expect(await tokenRowCount(token)).toBe(1);
  });

  it('needs no Idempotency-Key header (naturally idempotent)', async () => {
    const userId = await createUser();
    const cookie = await sessionCookieFor(userId);

    const res = await app.request(
      '/notifications/device-tokens',
      registerRequest(cookie, { token: freshToken(), platform: 'android' }),
      env
    );

    expect(res.status).toBe(201);
  });

  it('converges a repeated registration onto one row without an error', async () => {
    const userId = await createUser();
    const cookie = await sessionCookieFor(userId);
    const token = freshToken();
    const body = { token, platform: 'ios' };

    const first = await app.request(
      '/notifications/device-tokens',
      registerRequest(cookie, body),
      env
    );
    const second = await app.request(
      '/notifications/device-tokens',
      registerRequest(cookie, body),
      env
    );

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(await tokenRowCount(token)).toBe(1);
  });

  it('rejects an invalid body with the VALIDATION wire code', async () => {
    const userId = await createUser();
    const cookie = await sessionCookieFor(userId);

    const res = await app.request(
      '/notifications/device-tokens',
      registerRequest(cookie, { token: '', platform: 'windows' }),
      env
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'VALIDATION' });
  });
});

describe('DELETE /notifications/device-tokens/:token', () => {
  it('denies an anonymous request through the pipeline', async () => {
    const res = await app.request(
      `/notifications/device-tokens/${freshToken()}`,
      { method: 'DELETE' },
      env
    );

    expect(res.status).toBe(401);
  });

  it('unregisters an owned token', async () => {
    const userId = await createUser();
    const cookie = await sessionCookieFor(userId);
    const token = freshToken();
    await app.request(
      '/notifications/device-tokens',
      registerRequest(cookie, { token, platform: 'ios' }),
      env
    );

    const res = await app.request(
      `/notifications/device-tokens/${encodeURIComponent(token)}`,
      { method: 'DELETE', headers: { cookie } },
      env
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    expect(await tokenRowCount(token)).toBe(0);
  });

  it('answers an already-absent token as a no-op', async () => {
    const userId = await createUser();
    const cookie = await sessionCookieFor(userId);

    const res = await app.request(
      `/notifications/device-tokens/${freshToken()}`,
      { method: 'DELETE', headers: { cookie } },
      env
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: false });
  });
});

describe('POST /notifications/web-subscriptions', () => {
  function webSub(): { endpoint: string; keys: { p256dh: string; auth: string } } {
    return {
      endpoint: `https://push.example.com/${crypto.randomUUID()}`,
      keys: { p256dh: 'p256dh-value', auth: 'auth-value' },
    };
  }

  it('denies an anonymous request through the pipeline', async () => {
    const res = await app.request(
      '/notifications/web-subscriptions',
      registerRequest(undefined, webSub()),
      env
    );

    expect(res.status).toBe(401);
  });

  it('registers a web subscription as a web device-token row', async () => {
    const userId = await createUser();
    const cookie = await sessionCookieFor(userId);
    const body = webSub();

    const res = await app.request(
      '/notifications/web-subscriptions',
      registerRequest(cookie, body),
      env
    );

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ registered: true });
    const rows = await db
      .select({ platform: deviceTokens.platform, p256dh: deviceTokens.p256dh })
      .from(deviceTokens)
      .where(eq(deviceTokens.token, body.endpoint));
    expect(rows).toEqual([{ platform: 'web', p256dh: 'p256dh-value' }]);
  });

  it('rejects a malformed subscription with the VALIDATION wire code', async () => {
    const userId = await createUser();
    const cookie = await sessionCookieFor(userId);

    const res = await app.request(
      '/notifications/web-subscriptions',
      registerRequest(cookie, { endpoint: 'not-a-url', keys: { p256dh: 'x', auth: 'y' } }),
      env
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'VALIDATION' });
  });
});

describe('GET /notifications/preferences', () => {
  it('denies an anonymous request through the pipeline', async () => {
    const res = await app.request('/notifications/preferences', { method: 'GET' }, env);

    expect(res.status).toBe(401);
  });

  it('returns the defaults view for a user with no row', async () => {
    const userId = await createUser();
    const cookie = await sessionCookieFor(userId);

    const res = await app.request(
      '/notifications/preferences',
      { method: 'GET', headers: { cookie } },
      env
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      globalEnabled: true,
      messages: true,
      runCompletion: true,
      membership: true,
      quietHours: null,
    });
  });
});

describe('PUT /notifications/preferences', () => {
  const validBody = {
    globalEnabled: true,
    messages: false,
    runCompletion: true,
    membership: false,
    quietHours: { startMinutes: 1320, endMinutes: 420, timezone: 'America/New_York' },
  };

  function putRequest(cookie: string, body: unknown): RequestInit {
    return {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify(body),
    };
  }

  it('saves and echoes the preferences, then reads them back', async () => {
    const userId = await createUser();
    const cookie = await sessionCookieFor(userId);

    const put = await app.request('/notifications/preferences', putRequest(cookie, validBody), env);
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual(validBody);

    const get = await app.request(
      '/notifications/preferences',
      { method: 'GET', headers: { cookie } },
      env
    );
    expect(await get.json()).toEqual(validBody);
  });

  it('converges a repeated write on one row (naturally idempotent)', async () => {
    const userId = await createUser();
    const cookie = await sessionCookieFor(userId);

    const first = await app.request(
      '/notifications/preferences',
      putRequest(cookie, validBody),
      env
    );
    const second = await app.request(
      '/notifications/preferences',
      putRequest(cookie, { ...validBody, quietHours: null }),
      env
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ ...validBody, quietHours: null });
  });

  it('rejects an unknown timezone with the VALIDATION wire code', async () => {
    const userId = await createUser();
    const cookie = await sessionCookieFor(userId);

    const res = await app.request(
      '/notifications/preferences',
      putRequest(cookie, {
        ...validBody,
        quietHours: { startMinutes: 0, endMinutes: 60, timezone: 'Not/AZone' },
      }),
      env
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'VALIDATION' });
  });
});

describe('store failure mapping', () => {
  const failingStore: DeviceTokenStore = {
    upsert: () => errAsync(unavailableError('store down')),
    deleteByToken: () => errAsync(unavailableError('store down')),
    listTokensForUsers: () => errAsync(unavailableError('store down')),
    touchLastSeen: () => errAsync(unavailableError('store down')),
  };
  const failingPreferencesStore: NotificationPreferencesStore = {
    read: () => errAsync(unavailableError('store down')),
    readForUsers: () => errAsync(unavailableError('store down')),
    upsert: () => errAsync(unavailableError('store down')),
  };
  const failingManifest = createNotificationsManifest({
    deviceTokenStore: () => failingStore,
    preferencesStore: () => failingPreferencesStore,
  });
  const failingApp = applyPipeline(new Hono<AppEnv>()).route(
    failingManifest.basePath,
    failingManifest.routes
  );

  it('answers a register store failure with the UNAVAILABLE wire code', async () => {
    const userId = await createUser();
    const cookie = await sessionCookieFor(userId);

    const res = await failingApp.request(
      '/notifications/device-tokens',
      registerRequest(cookie, { token: freshToken(), platform: 'ios' }),
      env
    );

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: 'UNAVAILABLE' });
  });

  it('answers an unregister store failure with the UNAVAILABLE wire code', async () => {
    const userId = await createUser();
    const cookie = await sessionCookieFor(userId);

    const res = await failingApp.request(
      `/notifications/device-tokens/${freshToken()}`,
      { method: 'DELETE', headers: { cookie } },
      env
    );

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: 'UNAVAILABLE' });
  });

  it('answers a web-subscription store failure with the UNAVAILABLE wire code', async () => {
    const userId = await createUser();
    const cookie = await sessionCookieFor(userId);

    const res = await failingApp.request(
      '/notifications/web-subscriptions',
      registerRequest(cookie, {
        endpoint: `https://push.example.com/${crypto.randomUUID()}`,
        keys: { p256dh: 'p', auth: 'a' },
      }),
      env
    );

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: 'UNAVAILABLE' });
  });

  it('answers a preferences read failure with the UNAVAILABLE wire code', async () => {
    const userId = await createUser();
    const cookie = await sessionCookieFor(userId);

    const res = await failingApp.request(
      '/notifications/preferences',
      { method: 'GET', headers: { cookie } },
      env
    );

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: 'UNAVAILABLE' });
  });

  it('answers a preferences write failure with the UNAVAILABLE wire code', async () => {
    const userId = await createUser();
    const cookie = await sessionCookieFor(userId);

    const res = await failingApp.request(
      '/notifications/preferences',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify({
          globalEnabled: true,
          messages: true,
          runCompletion: true,
          membership: true,
          quietHours: null,
        }),
      },
      env
    );

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: 'UNAVAILABLE' });
  });
});
