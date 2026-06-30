import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono, type MiddlewareHandler } from 'hono';

/** Type-safe JSON response parser for test assertions. */
async function jsonBody<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

vi.mock('@hushbox/db', () => ({
  createDb: vi.fn(() => ({ mocked: 'db' })),
  LOCAL_NEON_DEV_CONFIG: { mocked: 'config' },
  users: {
    id: 'users.id',
    email: 'users.email',
    username: 'users.username',
    emailVerified: 'users.emailVerified',
    totpEnabled: 'users.totpEnabled',
    hasAcknowledgedPhrase: 'users.hasAcknowledgedPhrase',
    publicKey: 'users.publicKey',
  },
}));

vi.mock('../services/email/index.js', () => ({
  getEmailClient: vi.fn(() => ({ type: 'email' })),
}));

vi.mock('../services/helcim/index.js', () => ({
  getHelcimClient: vi.fn(() => ({ type: 'helcim', isMock: false })),
}));

function createMockRedisInstance(): Record<string, unknown> {
  const store = new Map<string, unknown>();
  return {
    mocked: 'redis',
    get: vi.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
    set: vi.fn((key: string, value: unknown) => {
      store.set(key, value);
      return Promise.resolve('OK');
    }),
    del: vi.fn((key: string) => {
      store.delete(key);
      return Promise.resolve(1);
    }),
    _store: store,
  };
}

vi.mock('../lib/redis.js', () => ({
  createRedisClient: vi.fn(() => createMockRedisInstance()),
}));

vi.mock('iron-session', () => ({
  getIronSession: vi.fn(),
}));

import { createDb, LOCAL_NEON_DEV_CONFIG } from '@hushbox/db';
import {
  dbMiddleware,
  redisMiddleware,
  sessionMiddleware,
  helcimMiddleware,
  envMiddleware,
  ironSessionMiddleware,
  mediaStorageMiddleware,
} from './dependencies.js';
import { getHelcimClient } from '../services/helcim/index.js';
import { createRedisClient } from '../lib/redis.js';
import type { AppEnv } from '../types.js';

describe('dbMiddleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('sets db on context', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', envMiddleware());
    app.use('*', dbMiddleware());
    app.get('/', (c) => {
      c.get('db');
      return c.json({ hasDb: true });
    });

    const res = await app.request(
      '/',
      {},
      { DATABASE_URL: 'postgres://test', NODE_ENV: 'production' }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ hasDb: true });
  });

  it('uses LOCAL_NEON_DEV_CONFIG in development mode', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', envMiddleware());
    app.use('*', dbMiddleware());
    app.get('/', (c) => c.json({ ok: true }));

    await app.request('/', {}, { DATABASE_URL: 'postgres://test', NODE_ENV: 'development' });

    expect(createDb).toHaveBeenCalledWith({
      connectionString: 'postgres://test',
      neonDev: LOCAL_NEON_DEV_CONFIG,
    });
  });

  it('omits neonDev config in production mode', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', envMiddleware());
    app.use('*', dbMiddleware());
    app.get('/', (c) => c.json({ ok: true }));

    await app.request('/', {}, { DATABASE_URL: 'postgres://test', NODE_ENV: 'production' });

    expect(createDb).toHaveBeenCalledWith({
      connectionString: 'postgres://test',
    });
  });

  it('calls next() to continue middleware chain', async () => {
    const app = new Hono<AppEnv>();
    const nextCalled = vi.fn();
    app.use('*', envMiddleware());
    app.use('*', dbMiddleware());
    app.use('*', async (_, next) => {
      nextCalled();
      await next();
    });
    app.get('/', (c) => c.json({ ok: true }));

    await app.request('/', {}, { DATABASE_URL: 'postgres://test' });

    expect(nextCalled).toHaveBeenCalled();
  });
});

describe('sessionMiddleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('returns 401 when no session exists (OPAQUE auth gate)', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', envMiddleware());
    app.use('*', dbMiddleware());
    app.use('*', sessionMiddleware());
    app.get('/', (c) => {
      return c.json({ message: 'should not reach here' });
    });

    const res = await app.request('/', {}, { DATABASE_URL: 'postgres://test' });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ code: 'NOT_AUTHENTICATED' });
  });

  it('passes through without setting user when link guest header is present', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', envMiddleware());
    app.use('*', dbMiddleware());
    app.use('*', sessionMiddleware());
    app.get('/', (c) => {
      const user = c.get('user');
      return c.json({ hasUser: !!user });
    });

    const res = await app.request(
      '/',
      { headers: { 'x-link-public-key': 'some-base64-key' } },
      { DATABASE_URL: 'postgres://test' }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ hasUser: false });
  });

  it('passes through without setting user when link guest is identified via query param', async () => {
    // WebSocket upgrades cannot set custom headers, so the link key arrives as a
    // `?linkPublicKey=` query param — the same way resolveLinkGuest reads it.
    const app = new Hono<AppEnv>();
    app.use('*', envMiddleware());
    app.use('*', dbMiddleware());
    app.use('*', sessionMiddleware());
    app.get('/', (c) => {
      const user = c.get('user');
      return c.json({ hasUser: !!user });
    });

    const res = await app.request(
      '/?linkPublicKey=some-base64-key',
      {},
      { DATABASE_URL: 'postgres://test' }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ hasUser: false });
  });

  it('returns 401 when session is not active in Redis', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', envMiddleware());
    app.use('*', dbMiddleware());
    app.use('*', redisMiddleware());
    app.use('*', (c, next) => {
      c.set('sessionData', {
        sessionId: 'test-session-id',
        userId: 'test-user-id',
        email: 'test@example.com',
        username: 'test_user',
        emailVerified: true,
        totpEnabled: false,
        hasAcknowledgedPhrase: false,
        pending2FA: false,
        pending2FAExpiresAt: 0,
        createdAt: Date.now(),
      });
      return next();
    });
    app.use('*', sessionMiddleware());
    app.get('/', (c) => {
      return c.json({ message: 'should not reach here' });
    });

    const res = await app.request(
      '/',
      {},
      {
        DATABASE_URL: 'postgres://test',
        UPSTASH_REDIS_REST_URL: 'http://localhost:8079',
        UPSTASH_REDIS_REST_TOKEN: 'test-token',
      }
    );
    expect(res.status).toBe(401);
  });

  it('returns 401 when session predates password change', async () => {
    const app = new Hono<AppEnv>();
    const createdAt = Date.now() - 10_000;
    const passwordChangedAt = Date.now();

    app.use('*', envMiddleware());
    app.use('*', dbMiddleware());
    app.use('*', redisMiddleware());
    app.use('*', async (c, next) => {
      const redis = c.get('redis');
      const { redisSet } = await import('../lib/redis-registry.js');
      await redisSet(redis, 'sessionActive', '1', 'test-user-id', 'test-session-id');
      await redisSet(redis, 'passwordChangedAt', passwordChangedAt, 'test-user-id');
      c.set('sessionData', {
        sessionId: 'test-session-id',
        userId: 'test-user-id',
        email: 'test@example.com',
        username: 'test_user',
        emailVerified: true,
        totpEnabled: false,
        hasAcknowledgedPhrase: false,
        pending2FA: false,
        pending2FAExpiresAt: 0,
        createdAt,
      });
      return next();
    });
    app.use('*', sessionMiddleware());
    app.get('/', (c) => {
      return c.json({ message: 'should not reach here' });
    });

    const res = await app.request(
      '/',
      {},
      {
        DATABASE_URL: 'postgres://test',
        UPSTASH_REDIS_REST_URL: 'http://localhost:8079',
        UPSTASH_REDIS_REST_TOKEN: 'test-token',
      }
    );
    expect(res.status).toBe(401);
  });

  it('falls back to link guest when session is revoked and link header present', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', envMiddleware());
    app.use('*', dbMiddleware());
    app.use('*', redisMiddleware());
    app.use('*', (c, next) => {
      c.set('sessionData', {
        sessionId: 'test-session-id',
        userId: 'test-user-id',
        email: 'test@example.com',
        username: 'test_user',
        emailVerified: true,
        totpEnabled: false,
        hasAcknowledgedPhrase: false,
        pending2FA: false,
        pending2FAExpiresAt: 0,
        createdAt: Date.now(),
      });
      return next();
    });
    app.use('*', sessionMiddleware());
    app.get('/', (c) => {
      const user = c.get('user');
      return c.json({ hasUser: !!user });
    });

    const res = await app.request(
      '/',
      { headers: { 'x-link-public-key': 'some-base64-key' } },
      {
        DATABASE_URL: 'postgres://test',
        UPSTASH_REDIS_REST_URL: 'http://localhost:8079',
        UPSTASH_REDIS_REST_TOKEN: 'test-token',
      }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ hasUser: false });
  });

  it('still returns 401 when session is revoked and no link header', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', envMiddleware());
    app.use('*', dbMiddleware());
    app.use('*', redisMiddleware());
    app.use('*', (c, next) => {
      c.set('sessionData', {
        sessionId: 'test-session-id',
        userId: 'test-user-id',
        email: 'test@example.com',
        username: 'test_user',
        emailVerified: true,
        totpEnabled: false,
        hasAcknowledgedPhrase: false,
        pending2FA: false,
        pending2FAExpiresAt: 0,
        createdAt: Date.now(),
      });
      return next();
    });
    app.use('*', sessionMiddleware());
    app.get('/', (c) => c.json({ message: 'should not reach here' }));

    const res = await app.request(
      '/',
      {},
      {
        DATABASE_URL: 'postgres://test',
        UPSTASH_REDIS_REST_URL: 'http://localhost:8079',
        UPSTASH_REDIS_REST_TOKEN: 'test-token',
      }
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ code: 'SESSION_REVOKED' });
  });

  it('falls back to link guest when password changed and link header present', async () => {
    const app = new Hono<AppEnv>();
    const createdAt = Date.now() - 10_000;
    const passwordChangedAt = Date.now();

    app.use('*', envMiddleware());
    app.use('*', dbMiddleware());
    app.use('*', redisMiddleware());
    app.use('*', async (c, next) => {
      const redis = c.get('redis');
      const { redisSet } = await import('../lib/redis-registry.js');
      await redisSet(redis, 'sessionActive', '1', 'test-user-id', 'test-session-id');
      await redisSet(redis, 'passwordChangedAt', passwordChangedAt, 'test-user-id');
      c.set('sessionData', {
        sessionId: 'test-session-id',
        userId: 'test-user-id',
        email: 'test@example.com',
        username: 'test_user',
        emailVerified: true,
        totpEnabled: false,
        hasAcknowledgedPhrase: false,
        pending2FA: false,
        pending2FAExpiresAt: 0,
        createdAt,
      });
      return next();
    });
    app.use('*', sessionMiddleware());
    app.get('/', (c) => {
      const user = c.get('user');
      return c.json({ hasUser: !!user });
    });

    const res = await app.request(
      '/',
      { headers: { 'x-link-public-key': 'some-base64-key' } },
      {
        DATABASE_URL: 'postgres://test',
        UPSTASH_REDIS_REST_URL: 'http://localhost:8079',
        UPSTASH_REDIS_REST_TOKEN: 'test-token',
      }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ hasUser: false });
  });

  it('falls back to link guest when 2FA expired and link header present', async () => {
    const app = new Hono<AppEnv>();

    app.use('*', envMiddleware());
    app.use('*', dbMiddleware());
    app.use('*', redisMiddleware());
    app.use('*', async (c, next) => {
      const redis = c.get('redis');
      const { redisSet } = await import('../lib/redis-registry.js');
      await redisSet(redis, 'sessionActive', '1', 'test-user-id', 'test-session-id');
      c.set('sessionData', {
        sessionId: 'test-session-id',
        userId: 'test-user-id',
        email: 'test@example.com',
        username: 'test_user',
        emailVerified: true,
        totpEnabled: true,
        hasAcknowledgedPhrase: false,
        pending2FA: true,
        pending2FAExpiresAt: Date.now() - 1000, // expired
        createdAt: Date.now(),
      });
      return next();
    });
    app.use('*', sessionMiddleware());
    app.get('/', (c) => {
      const user = c.get('user');
      return c.json({ hasUser: !!user });
    });

    const res = await app.request(
      '/',
      { headers: { 'x-link-public-key': 'some-base64-key' } },
      {
        DATABASE_URL: 'postgres://test',
        UPSTASH_REDIS_REST_URL: 'http://localhost:8079',
        UPSTASH_REDIS_REST_TOKEN: 'test-token',
      }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ hasUser: false });
  });

  it('does NOT fall back for 2FA_REQUIRED even with link header', async () => {
    const app = new Hono<AppEnv>();

    app.use('*', envMiddleware());
    app.use('*', dbMiddleware());
    app.use('*', redisMiddleware());
    app.use('*', async (c, next) => {
      const redis = c.get('redis');
      const { redisSet } = await import('../lib/redis-registry.js');
      await redisSet(redis, 'sessionActive', '1', 'test-user-id', 'test-session-id');
      c.set('sessionData', {
        sessionId: 'test-session-id',
        userId: 'test-user-id',
        email: 'test@example.com',
        username: 'test_user',
        emailVerified: true,
        totpEnabled: true,
        hasAcknowledgedPhrase: false,
        pending2FA: true,
        pending2FAExpiresAt: Date.now() + 60_000, // not expired
        createdAt: Date.now(),
      });
      return next();
    });
    app.use('*', sessionMiddleware());
    app.get('/', (c) => c.json({ message: 'should not reach here' }));

    const res = await app.request(
      '/',
      { headers: { 'x-link-public-key': 'some-base64-key' } },
      {
        DATABASE_URL: 'postgres://test',
        UPSTASH_REDIS_REST_URL: 'http://localhost:8079',
        UPSTASH_REDIS_REST_TOKEN: 'test-token',
      }
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toEqual({ code: '2FA_REQUIRED' });
  });

  it('falls back to link guest when user not found and link header present', async () => {
    const app = new Hono<AppEnv>();
    /* eslint-disable unicorn/no-thenable -- mock Drizzle query builder chain */
    const emptyDb = {
      select: () => ({
        from: () => ({
          where: () => ({
            then: (resolve: (v: unknown[]) => unknown) => Promise.resolve(resolve([])),
          }),
        }),
      }),
    };
    /* eslint-enable unicorn/no-thenable */

    app.use('*', envMiddleware());
    app.use('*', redisMiddleware());
    app.use('*', async (c, next) => {
      c.set('db', emptyDb as unknown as AppEnv['Variables']['db']);
      const redis = c.get('redis');
      const { redisSet } = await import('../lib/redis-registry.js');
      await redisSet(redis, 'sessionActive', '1', 'test-user-id', 'test-session-id');
      c.set('sessionData', {
        sessionId: 'test-session-id',
        userId: 'test-user-id',
        email: 'test@example.com',
        username: 'test_user',
        emailVerified: true,
        totpEnabled: false,
        hasAcknowledgedPhrase: false,
        pending2FA: false,
        pending2FAExpiresAt: 0,
        createdAt: Date.now(),
      });
      return next();
    });
    app.use('*', sessionMiddleware());
    app.get('/', (c) => {
      const user = c.get('user');
      return c.json({ hasUser: !!user });
    });

    const res = await app.request(
      '/',
      { headers: { 'x-link-public-key': 'some-base64-key' } },
      {
        DATABASE_URL: 'postgres://test',
        UPSTASH_REDIS_REST_URL: 'http://localhost:8079',
        UPSTASH_REDIS_REST_TOKEN: 'test-token',
      }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ hasUser: false });
  });

  // Helper to create a test app at a specific path with billing-scoped session
  function createBillingSessionApp(routePath: string): {
    app: Hono<AppEnv>;
    env: Record<string, string>;
  } {
    const testApp = new Hono<AppEnv>();
    const env = {
      DATABASE_URL: 'postgres://test',
      UPSTASH_REDIS_REST_URL: 'http://localhost:8079',
      UPSTASH_REDIS_REST_TOKEN: 'test-token',
    };

    testApp.use('*', envMiddleware());
    testApp.use('*', dbMiddleware());
    testApp.use('*', redisMiddleware());
    testApp.use('*', async (c, next) => {
      // Seed sessionActive in Redis so the session passes the active check
      const redis = c.get('redis');
      const { redisSet } = await import('../lib/redis-registry.js');
      await redisSet(redis, 'sessionActive', '1', 'billing-user', 'billing-session');

      c.set('sessionData', {
        sessionId: 'billing-session',
        userId: 'billing-user',
        email: 'billing@example.com',
        username: 'billing_user',
        emailVerified: true,
        totpEnabled: false,
        hasAcknowledgedPhrase: true,
        pending2FA: false,
        pending2FAExpiresAt: 0,
        createdAt: Date.now(),
        billingOnly: true,
      });
      return next();
    });
    testApp.use('*', sessionMiddleware());
    testApp.get(routePath, (c) => c.json({ allowed: true }));

    return { app: testApp, env };
  }

  it('returns 403 for billing-only session accessing non-billing route', async () => {
    const { app: testApp, env } = createBillingSessionApp('/api/conversations');

    const res = await testApp.request('/api/conversations', {}, env);

    expect(res.status).toBe(403);
    const body = await jsonBody<{ code: string }>(res);
    expect(body.code).toBe('BILLING_SESSION_RESTRICTED');
  });

  it('allows billing-only session to access /api/billing routes', async () => {
    const { app: testApp, env } = createBillingSessionApp('/api/billing/balance');

    const res = await testApp.request('/api/billing/balance', {}, env);

    // Will fail at DB lookup (mocked), but should NOT be 403
    // The important thing is it doesn't return BILLING_SESSION_RESTRICTED
    expect(res.status).not.toBe(403);
  });

  it('allows billing-only session to access /api/auth routes', async () => {
    const { app: testApp, env } = createBillingSessionApp('/api/auth/me');

    const res = await testApp.request('/api/auth/me', {}, env);

    expect(res.status).not.toBe(403);
  });

  it('allows normal sessions (no billingOnly) to access any route', async () => {
    const testApp = new Hono<AppEnv>();
    const env = {
      DATABASE_URL: 'postgres://test',
      UPSTASH_REDIS_REST_URL: 'http://localhost:8079',
      UPSTASH_REDIS_REST_TOKEN: 'test-token',
    };

    testApp.use('*', envMiddleware());
    testApp.use('*', dbMiddleware());
    testApp.use('*', redisMiddleware());
    testApp.use('*', async (c, next) => {
      const redis = c.get('redis');
      const { redisSet } = await import('../lib/redis-registry.js');
      await redisSet(redis, 'sessionActive', '1', 'normal-user', 'normal-session');

      c.set('sessionData', {
        sessionId: 'normal-session',
        userId: 'normal-user',
        email: 'normal@example.com',
        username: 'normal_user',
        emailVerified: true,
        totpEnabled: false,
        hasAcknowledgedPhrase: true,
        pending2FA: false,
        pending2FAExpiresAt: 0,
        createdAt: Date.now(),
        // billingOnly NOT set
      });
      return next();
    });
    testApp.use('*', sessionMiddleware());
    testApp.get('/api/conversations', (c) => c.json({ allowed: true }));

    const res = await testApp.request('/api/conversations', {}, env);

    // Will proceed past billing check (no billingOnly flag)
    // Will fail at DB lookup, but NOT with 403
    expect(res.status).not.toBe(403);
  });
});

describe('helcimMiddleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  function setupHelcimContext(): MiddlewareHandler<AppEnv> {
    return async (c, next) => {
      c.set('db', {} as never);
      c.set('envUtils', { isCI: false, isDev: false, isLocalDev: false } as never);
      await next();
    };
  }

  it('sets helcim on context', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', setupHelcimContext());
    app.use('*', helcimMiddleware());
    app.get('/', (c) => {
      c.get('helcim');
      return c.json({ hasHelcim: true });
    });

    const res = await app.request('/', {}, {});
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ hasHelcim: true });
  });

  it('passes env and evidence config to getHelcimClient factory', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', setupHelcimContext());
    app.use('*', helcimMiddleware());
    app.get('/', (c) => c.json({ ok: true }));

    const env = {
      HELCIM_API_TOKEN: 'test-token',
      HELCIM_WEBHOOK_VERIFIER: 'test-verifier',
      NODE_ENV: 'production',
    };
    await app.request('/', {}, env);

    expect(getHelcimClient).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ db: expect.any(Object), isCI: false })
    );
  });

  it('calls next() to continue middleware chain', async () => {
    const app = new Hono<AppEnv>();
    const nextCalled = vi.fn();
    app.use('*', setupHelcimContext());
    app.use('*', helcimMiddleware());
    app.use('*', async (_, next) => {
      nextCalled();
      await next();
    });
    app.get('/', (c) => c.json({ ok: true }));

    await app.request('/', {}, {});

    expect(nextCalled).toHaveBeenCalled();
  });
});

describe('envMiddleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('sets envUtils on context', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', envMiddleware());
    app.get('/', (c) => {
      c.get('envUtils'); // Verify it's set
      return c.json({ hasEnvUtils: true });
    });

    const res = await app.request('/', {}, { NODE_ENV: 'development' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ hasEnvUtils: true });
  });

  it('returns correct isDev flag for development', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', envMiddleware());
    app.get('/', (c) => {
      const { isDev, isLocalDev, isProduction } = c.get('envUtils');
      return c.json({ isDev, isLocalDev, isProduction });
    });

    const res = await app.request('/', {}, { NODE_ENV: 'development' });
    const body = await res.json();
    expect(body).toEqual({ isDev: true, isLocalDev: true, isProduction: false });
  });

  it('returns correct isCI flag when CI is set', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', envMiddleware());
    app.get('/', (c) => {
      const { isCI, isLocalDev, requiresRealServices } = c.get('envUtils');
      return c.json({ isCI, isLocalDev, requiresRealServices });
    });

    const res = await app.request('/', {}, { NODE_ENV: 'development', CI: 'true' });
    const body = await res.json();
    expect(body).toEqual({ isCI: true, isLocalDev: false, requiresRealServices: true });
  });

  it('returns correct isProduction flag for production', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', envMiddleware());
    app.get('/', (c) => {
      const { isDev, isProduction, requiresRealServices } = c.get('envUtils');
      return c.json({ isDev, isProduction, requiresRealServices });
    });

    const res = await app.request('/', {}, { NODE_ENV: 'production' });
    const body = await res.json();
    expect(body).toEqual({ isDev: false, isProduction: true, requiresRealServices: true });
  });

  it('returns correct isE2E flag when E2E is set', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', envMiddleware());
    app.get('/', (c) => {
      const { isCI, isE2E } = c.get('envUtils');
      return c.json({ isCI, isE2E });
    });

    const res = await app.request('/', {}, { NODE_ENV: 'development', CI: 'true', E2E: 'true' });
    const body = await res.json();
    expect(body).toEqual({ isCI: true, isE2E: true });
  });

  it('calls next() to continue middleware chain', async () => {
    const app = new Hono<AppEnv>();
    const nextCalled = vi.fn();
    app.use('*', envMiddleware());
    app.use('*', async (_, next) => {
      nextCalled();
      await next();
    });
    app.get('/', (c) => c.json({ ok: true }));

    await app.request('/', {}, { NODE_ENV: 'development' });

    expect(nextCalled).toHaveBeenCalled();
  });
});

describe('redisMiddleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('sets redis on context', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', redisMiddleware());
    app.get('/', (c) => {
      c.get('redis');
      return c.json({ hasRedis: true });
    });

    const res = await app.request(
      '/',
      {},
      { UPSTASH_REDIS_REST_URL: 'http://localhost:8079', UPSTASH_REDIS_REST_TOKEN: 'test-token' }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ hasRedis: true });
  });

  it('passes env config to createRedisClient factory', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', redisMiddleware());
    app.get('/', (c) => c.json({ ok: true }));

    const env = {
      UPSTASH_REDIS_REST_URL: 'https://redis.upstash.io',
      UPSTASH_REDIS_REST_TOKEN: 'prod-token',
    };
    await app.request('/', {}, env);

    expect(createRedisClient).toHaveBeenCalledWith('https://redis.upstash.io', 'prod-token');
  });

  it('throws when UPSTASH_REDIS_REST_URL is missing', async () => {
    const app = new Hono<AppEnv>();
    app.onError((err, c) => c.json({ error: (err as Error).message }, 500));
    app.use('*', redisMiddleware());
    app.get('/', (c) => c.json({ ok: true }));

    const res = await app.request('/', {}, { UPSTASH_REDIS_REST_TOKEN: 'test-token' });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({
      error: 'UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required',
    });
  });

  it('throws when UPSTASH_REDIS_REST_TOKEN is missing', async () => {
    const app = new Hono<AppEnv>();
    app.onError((err, c) => c.json({ error: (err as Error).message }, 500));
    app.use('*', redisMiddleware());
    app.get('/', (c) => c.json({ ok: true }));

    const res = await app.request('/', {}, { UPSTASH_REDIS_REST_URL: 'http://localhost:8079' });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({
      error: 'UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required',
    });
  });

  it('calls next() to continue middleware chain', async () => {
    const app = new Hono<AppEnv>();
    const nextCalled = vi.fn();
    app.use('*', redisMiddleware());
    app.use('*', async (_, next) => {
      nextCalled();
      await next();
    });
    app.get('/', (c) => c.json({ ok: true }));

    await app.request(
      '/',
      {},
      { UPSTASH_REDIS_REST_URL: 'http://localhost:8079', UPSTASH_REDIS_REST_TOKEN: 'test-token' }
    );

    expect(nextCalled).toHaveBeenCalled();
  });
});

describe('mediaStorageMiddleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('sets mediaStorage on context with the expected MediaStorage shape', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', envMiddleware());
    app.use('*', mediaStorageMiddleware());
    app.get('/', (c) => {
      const storage = c.get('mediaStorage');
      return c.json({
        hasPut: typeof storage.put === 'function',
        hasDelete: typeof storage.delete === 'function',
        hasList: typeof storage.list === 'function',
        hasMint: typeof storage.mintDownloadUrl === 'function',
      });
    });

    const res = await app.request(
      '/',
      {},
      {
        NODE_ENV: 'development',
        R2_S3_ENDPOINT: 'http://localhost:9000',
        R2_ACCESS_KEY_ID: 'minioadmin',
        R2_SECRET_ACCESS_KEY: 'minioadmin',
        R2_BUCKET_MEDIA: 'hushbox-media-dev',
      }
    );
    expect(res.status).toBe(200);
    const body = await jsonBody<{
      hasPut: boolean;
      hasDelete: boolean;
      hasList: boolean;
      hasMint: boolean;
    }>(res);
    expect(body).toEqual({ hasPut: true, hasDelete: true, hasList: true, hasMint: true });
  });

  it('calls next() to continue middleware chain', async () => {
    const app = new Hono<AppEnv>();
    const nextCalled = vi.fn();
    app.use('*', envMiddleware());
    app.use('*', mediaStorageMiddleware());
    app.use('*', async (_, next) => {
      nextCalled();
      await next();
    });
    app.get('/', (c) => c.json({ ok: true }));

    await app.request(
      '/',
      {},
      {
        NODE_ENV: 'development',
        R2_S3_ENDPOINT: 'http://localhost:9000',
        R2_ACCESS_KEY_ID: 'minioadmin',
        R2_SECRET_ACCESS_KEY: 'minioadmin',
        R2_BUCKET_MEDIA: 'hushbox-media-dev',
      }
    );

    expect(nextCalled).toHaveBeenCalled();
  });
});

describe('ironSessionMiddleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('returns a middleware function', () => {
    const middleware = ironSessionMiddleware();

    expect(middleware).toBeDefined();
    expect(typeof middleware).toBe('function');
  });

  it('sets sessionData to null when no IRON_SESSION_SECRET', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', ironSessionMiddleware());
    app.get('/', (c) => {
      const sessionData = c.get('sessionData');
      return c.json({ sessionData });
    });

    const res = await app.request('/', {}, { DATABASE_URL: 'postgres://test' });
    expect(res.status).toBe(200);
    const body = await jsonBody<{ sessionData: unknown }>(res);
    expect(body.sessionData).toBeNull();
  });

  it('calls next() to continue middleware chain', async () => {
    const app = new Hono<AppEnv>();
    const nextCalled = vi.fn();
    app.use('*', ironSessionMiddleware());
    app.use('*', async (_, next) => {
      nextCalled();
      await next();
    });
    app.get('/', (c) => c.json({ ok: true }));

    await app.request('/', {}, { DATABASE_URL: 'postgres://test' });

    expect(nextCalled).toHaveBeenCalled();
  });
});
