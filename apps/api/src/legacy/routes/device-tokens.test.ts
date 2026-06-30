import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { deviceTokensRoute } from './device-tokens.js';
import type { AppEnv } from '../types.js';
import type { SessionData } from '../lib/session.js';

const TEST_USER_ID = 'user-dt-123';

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

interface MockDbConfig {
  insertResult?: unknown[];
  deleteResult?: unknown[];
}

function createMockDb(config: MockDbConfig = {}): unknown {
  return {
    insert: () => ({
      values: () => ({
        onConflictDoUpdate: () => ({
          returning: () =>
            Promise.resolve(
              config.insertResult ?? [
                {
                  id: 'dt-1',
                  userId: TEST_USER_ID,
                  token: 'fcm-token-abc',
                  platform: 'android',
                },
              ]
            ),
        }),
      }),
    }),
    delete: () => ({
      where: () => Promise.resolve(config.deleteResult ?? [{ id: 'dt-1' }]),
    }),
  };
}

interface TestAppOptions {
  user?: AppEnv['Variables']['user'] | null;
  db?: unknown;
}

function createTestApp(options: TestAppOptions = {}): Hono<AppEnv> {
  const { user = createMockUser(), db = createMockDb() } = options;
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    c.env = { NODE_ENV: 'development' } as unknown as AppEnv['Bindings'];
    c.set('user', user);
    c.set('session', user ? createMockSession() : null);
    c.set('sessionData', user ? createMockSession() : null);
    c.set('db', db as AppEnv['Variables']['db']);
    await next();
  });

  app.route('/', deviceTokensRoute);
  return app;
}

describe('device-tokens route', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('POST /', () => {
    it('returns 401 when not authenticated', async () => {
      const app = createTestApp({ user: null });

      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'fcm-abc', platform: 'android' }),
      });

      expect(res.status).toBe(401);
      const body = await res.json<{ code: string }>();
      expect(body.code).toBe('NOT_AUTHENTICATED');
    });

    it('returns 400 when token is missing', async () => {
      const app = createTestApp();

      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: 'android' }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 when platform is invalid', async () => {
      const app = createTestApp();

      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'fcm-abc', platform: 'windows' }),
      });

      expect(res.status).toBe(400);
    });

    it('registers a device token and returns 201', async () => {
      const app = createTestApp();

      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'fcm-token-abc', platform: 'android' }),
      });

      expect(res.status).toBe(201);
      const body = await res.json<{ registered: boolean }>();
      expect(body.registered).toBe(true);
    });

    it('accepts ios platform', async () => {
      const app = createTestApp();

      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'apns-token', platform: 'ios' }),
      });

      expect(res.status).toBe(201);
    });
  });

  describe('DELETE /:token', () => {
    it('returns 401 when not authenticated', async () => {
      const app = createTestApp({ user: null });

      const res = await app.request('/fcm-token-abc', {
        method: 'DELETE',
      });

      expect(res.status).toBe(401);
      const body = await res.json<{ code: string }>();
      expect(body.code).toBe('NOT_AUTHENTICATED');
    });

    it('deletes a device token and returns 200', async () => {
      const app = createTestApp();

      const res = await app.request('/fcm-token-abc', {
        method: 'DELETE',
      });

      expect(res.status).toBe(200);
      const body = await res.json<{ deleted: boolean }>();
      expect(body.deleted).toBe(true);
    });
  });
});
