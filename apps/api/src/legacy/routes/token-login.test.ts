import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { tokenLoginRoute } from './token-login.js';
import type { AppEnv } from '../types.js';

async function jsonBody<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

// Map-based Redis mock that supports get/set/del for verifying one-time token use
function createMapRedis(): {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
  store: Map<string, unknown>;
} {
  const store = new Map<string, unknown>();
  return {
    store,
    get: vi.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
    set: vi.fn((key: string, value: unknown) => {
      store.set(key, value);
      return Promise.resolve('OK');
    }),
    del: vi.fn((key: string) => {
      store.delete(key);
      return Promise.resolve(1);
    }),
  };
}

// Mock Drizzle query builder chain for user lookup
/* eslint-disable unicorn/no-thenable -- mock Drizzle query builder chain */
function createMockDb(
  user: {
    id: string;
    email: string | null;
    username: string;
    emailVerified: boolean;
    totpEnabled: boolean;
    hasAcknowledgedPhrase: boolean;
  } | null
): unknown {
  const makeChain = (): Record<string, unknown> => ({
    from: () => makeChain(),
    where: () => makeChain(),
    then: (resolve: (v: unknown[]) => unknown) => {
      return Promise.resolve(resolve(user ? [user] : []));
    },
  });

  return {
    select: () => makeChain(),
  };
}
/* eslint-enable unicorn/no-thenable */

const DEFAULT_USER = {
  id: 'user-1',
  email: 'user@example.com',
  username: 'testuser',
  emailVerified: true,
  totpEnabled: false,
  hasAcknowledgedPhrase: true,
};

function createTestApp(options?: {
  redis?: ReturnType<typeof createMapRedis>;
  db?: unknown;
  ironSessionSecret?: string | undefined;
}): {
  app: Hono<AppEnv>;
  redis: ReturnType<typeof createMapRedis>;
} {
  const redis = options?.redis ?? createMapRedis();
  const db = options?.db ?? createMockDb(DEFAULT_USER);
  const sessionSecret =
    options && 'ironSessionSecret' in options
      ? options.ironSessionSecret
      : 'test-secret-must-be-at-least-32-characters-long!!';

  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    c.env = {
      ...(sessionSecret === undefined ? {} : { IRON_SESSION_SECRET: sessionSecret }),
    } as unknown as AppEnv['Bindings'];
    c.set('db', db as AppEnv['Variables']['db']);
    c.set('redis', redis as unknown as AppEnv['Variables']['redis']);
    c.set('envUtils', {
      isCI: false,
      isE2E: false,
      isLocalDev: false,
      isDevServer: false,
      isDev: false,
      isProduction: false,
      requiresRealServices: false,
    });
    await next();
  });

  app.route('/auth/token-login', tokenLoginRoute);
  return { app, redis };
}

describe('POST /auth/token-login', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 400 when token is missing from body', async () => {
    const { app } = createTestApp();

    const res = await app.request('/auth/token-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
  });

  it('returns 401 when token is not found in Redis', async () => {
    const redis = createMapRedis();
    const { app } = createTestApp({ redis });

    const res = await app.request('/auth/token-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'a0000000-0000-4000-8000-000000000001' }),
    });

    expect(res.status).toBe(401);
    const data = await jsonBody<{ code: string }>(res);
    expect(data.code).toBe('LOGIN_TOKEN_INVALID');
  });

  it('returns 200 and sets session cookie on valid token', async () => {
    const redis = createMapRedis();
    redis.store.set('billing:login-token:a0000000-0000-4000-8000-000000000002', {
      userId: 'user-1',
    });
    const { app } = createTestApp({ redis });

    const res = await app.request('/auth/token-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'a0000000-0000-4000-8000-000000000002' }),
    });

    expect(res.status).toBe(200);
    const data = await jsonBody<{ success: boolean }>(res);
    expect(data.success).toBe(true);

    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toBeTruthy();
    expect(setCookie).toContain('hushbox_session');
  });

  it('does not delete token after redemption (idempotent via TTL)', async () => {
    const redis = createMapRedis();
    redis.store.set('billing:login-token:a0000000-0000-4000-8000-000000000003', {
      userId: 'user-1',
    });
    const { app } = createTestApp({ redis });

    await app.request('/auth/token-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'a0000000-0000-4000-8000-000000000003' }),
    });

    expect(redis.del).not.toHaveBeenCalled();
  });

  it('tracks session in Redis via sessionActive key', async () => {
    const redis = createMapRedis();
    redis.store.set('billing:login-token:a0000000-0000-4000-8000-000000000004', {
      userId: 'user-1',
    });
    const { app } = createTestApp({ redis });

    await app.request('/auth/token-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'a0000000-0000-4000-8000-000000000004' }),
    });

    // sessionActive key should be set: `sessions:user:active:{userId}:{sessionId}`
    const sessionActiveCall = redis.set.mock.calls.find(
      (call: unknown[]) =>
        typeof call[0] === 'string' && call[0].startsWith('sessions:user:active:user-1:')
    );
    expect(sessionActiveCall).toBeTruthy();
  });

  it('returns 401 when user is not found in database', async () => {
    const redis = createMapRedis();
    redis.store.set('billing:login-token:a0000000-0000-4000-8000-000000000005', {
      userId: 'nonexistent-user',
    });
    const db = createMockDb(null);
    const { app } = createTestApp({ redis, db });

    const res = await app.request('/auth/token-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'a0000000-0000-4000-8000-000000000005' }),
    });

    expect(res.status).toBe(401);
    const data = await jsonBody<{ code: string }>(res);
    expect(data.code).toBe('LOGIN_TOKEN_INVALID');
  });

  it('allows reuse within TTL window (idempotent design)', async () => {
    const redis = createMapRedis();
    redis.store.set('billing:login-token:a0000000-0000-4000-8000-000000000006', {
      userId: 'user-1',
    });
    const { app } = createTestApp({ redis });

    const res1 = await app.request('/auth/token-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'a0000000-0000-4000-8000-000000000006' }),
    });
    expect(res1.status).toBe(200);

    // Second use — still succeeds (token not deleted, expires via TTL)
    const res2 = await app.request('/auth/token-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'a0000000-0000-4000-8000-000000000006' }),
    });
    expect(res2.status).toBe(200);
  });

  it('returns 500 SERVER_MISCONFIGURED when IRON_SESSION_SECRET is missing', async () => {
    const redis = createMapRedis();
    redis.store.set('billing:login-token:a0000000-0000-4000-8000-000000000099', {
      userId: 'user-1',
    });
    const { app } = createTestApp({ redis, ironSessionSecret: undefined });

    const res = await app.request('/auth/token-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'a0000000-0000-4000-8000-000000000099' }),
    });

    expect(res.status).toBe(500);
    const data = await jsonBody<{ code: string }>(res);
    expect(data.code).toBe('SERVER_MISCONFIGURED');
  });

  it('fails fast on missing IRON_SESSION_SECRET before any I/O', async () => {
    // Locks in the fail-fast ordering: a misconfigured deployment must surface
    // 500 BEFORE the handler reads from Redis or queries the DB. If this test
    // fails, the secret check has slipped back below the I/O calls.
    const redis = createMapRedis();
    redis.store.set('billing:login-token:a0000000-0000-4000-8000-0000000000aa', {
      userId: 'user-1',
    });
    let dbCalled = false;
    const sentinelDb = {
      select: () => {
        dbCalled = true;
        return createMockDb(DEFAULT_USER) as { select: () => unknown };
      },
    };
    const { app } = createTestApp({
      redis,
      db: sentinelDb,
      ironSessionSecret: undefined,
    });

    const res = await app.request('/auth/token-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'a0000000-0000-4000-8000-0000000000aa' }),
    });

    expect(res.status).toBe(500);
    expect(redis.get).not.toHaveBeenCalled();
    expect(dbCalled).toBe(false);
  });

  it('retries produce the same sessionActive key (no orphaned sessions)', async () => {
    const redis = createMapRedis();
    redis.store.set('billing:login-token:a0000000-0000-4000-8000-000000000007', {
      userId: 'user-1',
    });
    const { app } = createTestApp({ redis });

    await app.request('/auth/token-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'a0000000-0000-4000-8000-000000000007' }),
    });

    await app.request('/auth/token-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'a0000000-0000-4000-8000-000000000007' }),
    });

    // Both calls should write the exact same sessionActive key
    const sessionActiveCalls = redis.set.mock.calls.filter(
      (call: unknown[]) =>
        typeof call[0] === 'string' && call[0].startsWith('sessions:user:active:user-1:')
    );
    expect(sessionActiveCalls).toHaveLength(2);
    expect(sessionActiveCalls[0]![0]).toBe(sessionActiveCalls[1]![0]);
  });
});
