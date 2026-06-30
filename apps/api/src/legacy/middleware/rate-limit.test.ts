import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { Hono } from 'hono';
import { rateLimitByCaller, rateLimitByIp } from './rate-limit';
import type { AppEnv } from '../types';

interface ErrorBody {
  code: string;
  details?: { retryAfterSeconds?: number };
}

function createMockRedis(): {
  store: Map<string, unknown>;
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
} {
  const store = new Map<string, unknown>();
  return {
    store,
    get: vi.fn().mockImplementation((key: string) => Promise.resolve(store.get(key) ?? null)),
    set: vi.fn().mockImplementation((key: string, value: unknown) => {
      store.set(key, value);
      return Promise.resolve('OK');
    }),
    del: vi.fn().mockImplementation((key: string) => {
      store.delete(key);
      return Promise.resolve(1);
    }),
  };
}

const TEST_USER_ID = 'user-rate-001';

function createMockUser(): NonNullable<AppEnv['Variables']['user']> {
  return {
    id: TEST_USER_ID,
    email: 'rate@example.com',
    username: 'rate_user',
    emailVerified: true,
    totpEnabled: false,
    hasAcknowledgedPhrase: true,
    publicKey: new Uint8Array(32),
  };
}

describe('rateLimitByCaller middleware', () => {
  let mockRedis: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    mockRedis = createMockRedis();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-15T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createApp(options: { callerId?: string | null } = {}): Hono<AppEnv> {
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.env = { NODE_ENV: 'development' } as unknown as AppEnv['Bindings'];
      c.set('user', createMockUser());
      const id = options.callerId === undefined ? TEST_USER_ID : options.callerId;
      if (id !== null) c.set('callerId', id);
      c.set('redis', mockRedis as unknown as AppEnv['Variables']['redis']);
      await next();
    });
    app.use('/protected/*', rateLimitByCaller('chatStreamUserRateLimit'));
    app.post('/protected/foo', (c) => c.json({ ok: true }));
    app.onError((error, c) => {
      return c.json({ code: 'INTERNAL', message: error.message }, 500);
    });
    return app;
  }

  it('allows request below limit', async () => {
    const app = createApp();
    const res = await app.request('/protected/foo', { method: 'POST' });
    expect(res.status).toBe(200);
  });

  it('throws (500) when callerId is missing — signals misconfigured middleware chain', async () => {
    const app = createApp({ callerId: null });
    const res = await app.request('/protected/foo', { method: 'POST' });
    expect(res.status).toBe(500);
  });

  it('returns 429 with RATE_LIMITED on the (N+1)th request within the window', async () => {
    const app = createApp();

    // Fire N=30 requests — all allowed
    for (let index = 0; index < 30; index++) {
      const res = await app.request('/protected/foo', { method: 'POST' });
      expect(res.status).toBe(200);
    }

    // (N+1)th — denied
    const res = await app.request('/protected/foo', { method: 'POST' });
    expect(res.status).toBe(429);
    const body: ErrorBody = await res.json();
    expect(body.code).toBe('RATE_LIMITED');
    expect(body.details?.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('allows requests again after the window expires', async () => {
    const app = createApp();

    for (let index = 0; index < 30; index++) {
      await app.request('/protected/foo', { method: 'POST' });
    }
    const blockedRes = await app.request('/protected/foo', { method: 'POST' });
    expect(blockedRes.status).toBe(429);

    // Advance system time past the 60-second window
    vi.advanceTimersByTime(61_000);

    const allowedRes = await app.request('/protected/foo', { method: 'POST' });
    expect(allowedRes.status).toBe(200);
  });
});

describe('rateLimitByIp middleware', () => {
  let mockRedis: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    mockRedis = createMockRedis();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-15T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createApp(): Hono<AppEnv> {
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.env = { NODE_ENV: 'development' } as unknown as AppEnv['Bindings'];
      c.set('redis', mockRedis as unknown as AppEnv['Variables']['redis']);
      await next();
    });
    app.use('/public/*', rateLimitByIp('shareGetIpRateLimit'));
    app.get('/public/foo', (c) => c.json({ ok: true }));
    return app;
  }

  it('allows request below limit', async () => {
    const app = createApp();
    const res = await app.request('/public/foo', {
      headers: { 'cf-connecting-ip': '1.2.3.4' },
    });
    expect(res.status).toBe(200);
  });

  it('returns 429 with RATE_LIMITED on the (N+1)th request within the window', async () => {
    const app = createApp();

    for (let index = 0; index < 30; index++) {
      const res = await app.request('/public/foo', {
        headers: { 'cf-connecting-ip': '5.6.7.8' },
      });
      expect(res.status).toBe(200);
    }

    const res = await app.request('/public/foo', {
      headers: { 'cf-connecting-ip': '5.6.7.8' },
    });
    expect(res.status).toBe(429);
    const body: ErrorBody = await res.json();
    expect(body.code).toBe('RATE_LIMITED');
    expect(body.details?.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('isolates limits across different IPs (one IP being limited does not block another)', async () => {
    const app = createApp();

    for (let index = 0; index < 30; index++) {
      await app.request('/public/foo', {
        headers: { 'cf-connecting-ip': '9.9.9.9' },
      });
    }
    const blocked = await app.request('/public/foo', {
      headers: { 'cf-connecting-ip': '9.9.9.9' },
    });
    expect(blocked.status).toBe(429);

    // Different IP — fresh window.
    const otherIpRes = await app.request('/public/foo', {
      headers: { 'cf-connecting-ip': '10.10.10.10' },
    });
    expect(otherIpRes.status).toBe(200);
  });

  it('allows requests again after the window expires', async () => {
    const app = createApp();

    for (let index = 0; index < 30; index++) {
      await app.request('/public/foo', {
        headers: { 'cf-connecting-ip': '7.7.7.7' },
      });
    }
    const blocked = await app.request('/public/foo', {
      headers: { 'cf-connecting-ip': '7.7.7.7' },
    });
    expect(blocked.status).toBe(429);

    vi.advanceTimersByTime(61_000);

    const allowed = await app.request('/public/foo', {
      headers: { 'cf-connecting-ip': '7.7.7.7' },
    });
    expect(allowed.status).toBe(200);
  });
});
