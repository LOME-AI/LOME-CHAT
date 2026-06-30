/**
 * Integration tests verifying rate-limit middleware is wired onto cost-amplification
 * routes (chat stream/regenerate, media presign, share create/get). These tests
 * confirm the (N+1)th request returns 429 and that the window resets correctly.
 *
 * The redis mock here is STATEFUL — unlike the per-call no-op mocks used by the
 * larger route tests, this one tracks rate-limit state so we can exercise the
 * window across many requests in one test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { rateLimitByCaller, rateLimitByIp } from './rate-limit';
import type { AppEnv } from '../types';
import type { SessionData } from '../lib/session';

const TEST_USER_ID = 'user-rate-route-001';

function createStatefulRedis(): {
  store: Map<string, unknown>;
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
  eval: ReturnType<typeof vi.fn>;
  scan: ReturnType<typeof vi.fn>;
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
    eval: vi.fn().mockResolvedValue('0'),
    scan: vi.fn().mockResolvedValue([0, []]),
  };
}

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

function createMockSession(): SessionData {
  return {
    sessionId: `session-${TEST_USER_ID}`,
    userId: TEST_USER_ID,
    email: 'rate@example.com',
    username: 'rate_user',
    emailVerified: true,
    totpEnabled: false,
    hasAcknowledgedPhrase: true,
    pending2FA: false,
    pending2FAExpiresAt: 0,
    createdAt: Date.now(),
  };
}

interface ErrorBody {
  code: string;
  details?: { retryAfterSeconds?: number };
}

describe('rate-limit on cost-amplification routes', () => {
  let redis: ReturnType<typeof createStatefulRedis>;

  beforeEach(() => {
    redis = createStatefulRedis();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-15T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('chatStreamUserRateLimit (per-user, 30/min)', () => {
    function createApp(): Hono<AppEnv> {
      const app = new Hono<AppEnv>();
      app.use('*', async (c, next) => {
        c.env = { NODE_ENV: 'development' } as unknown as AppEnv['Bindings'];
        c.set('user', createMockUser());
        c.set('callerId', createMockUser().id);
        c.set('session', createMockSession());
        c.set('sessionData', createMockSession());
        c.set('redis', redis as unknown as AppEnv['Variables']['redis']);
        await next();
      });
      app.use('*', rateLimitByCaller('chatStreamUserRateLimit'));
      app.post('/stream', (c) => c.json({ ok: true }));
      return app;
    }

    it('blocks the 31st request with 429 RATE_LIMITED', async () => {
      const app = createApp();
      for (let index = 0; index < 30; index++) {
        const res = await app.request('/stream', { method: 'POST' });
        expect(res.status).toBe(200);
      }
      const blocked = await app.request('/stream', { method: 'POST' });
      expect(blocked.status).toBe(429);
      const body: ErrorBody = await blocked.json();
      expect(body.code).toBe('RATE_LIMITED');
    });

    it('allows requests again after the 60s window expires', async () => {
      const app = createApp();
      for (let index = 0; index < 30; index++) {
        await app.request('/stream', { method: 'POST' });
      }
      const blocked = await app.request('/stream', { method: 'POST' });
      expect(blocked.status).toBe(429);

      vi.advanceTimersByTime(61_000);

      const allowed = await app.request('/stream', { method: 'POST' });
      expect(allowed.status).toBe(200);
    });
  });

  describe('mediaDownloadUserRateLimit (per-user, 60/min)', () => {
    function createApp(): Hono<AppEnv> {
      const app = new Hono<AppEnv>();
      app.use('*', async (c, next) => {
        c.env = { NODE_ENV: 'development' } as unknown as AppEnv['Bindings'];
        c.set('user', createMockUser());
        c.set('callerId', createMockUser().id);
        c.set('session', createMockSession());
        c.set('sessionData', createMockSession());
        c.set('redis', redis as unknown as AppEnv['Variables']['redis']);
        await next();
      });
      app.use('*', rateLimitByCaller('mediaDownloadUserRateLimit'));
      app.get('/download-url', (c) => c.json({ url: 'https://signed.example/x' }));
      return app;
    }

    it('blocks the 61st request with 429 RATE_LIMITED', async () => {
      const app = createApp();
      for (let index = 0; index < 60; index++) {
        const res = await app.request('/download-url');
        expect(res.status).toBe(200);
      }
      const blocked = await app.request('/download-url');
      expect(blocked.status).toBe(429);
      const body: ErrorBody = await blocked.json();
      expect(body.code).toBe('RATE_LIMITED');
    });

    it('allows requests again after the 60s window expires', async () => {
      const app = createApp();
      for (let index = 0; index < 60; index++) {
        await app.request('/download-url');
      }
      const blocked = await app.request('/download-url');
      expect(blocked.status).toBe(429);

      vi.advanceTimersByTime(61_000);

      const allowed = await app.request('/download-url');
      expect(allowed.status).toBe(200);
    });
  });

  describe('shareCreateUserRateLimit (per-user, 20/min)', () => {
    function createApp(): Hono<AppEnv> {
      const app = new Hono<AppEnv>();
      app.use('*', async (c, next) => {
        c.env = { NODE_ENV: 'development' } as unknown as AppEnv['Bindings'];
        c.set('user', createMockUser());
        c.set('callerId', createMockUser().id);
        c.set('session', createMockSession());
        c.set('sessionData', createMockSession());
        c.set('redis', redis as unknown as AppEnv['Variables']['redis']);
        await next();
      });
      app.use('*', rateLimitByCaller('shareCreateUserRateLimit'));
      app.post('/share', (c) => c.json({ shareId: 'sh-1' }, 201));
      return app;
    }

    it('blocks the 21st request with 429 RATE_LIMITED', async () => {
      const app = createApp();
      for (let index = 0; index < 20; index++) {
        const res = await app.request('/share', { method: 'POST' });
        expect(res.status).toBe(201);
      }
      const blocked = await app.request('/share', { method: 'POST' });
      expect(blocked.status).toBe(429);
      const body: ErrorBody = await blocked.json();
      expect(body.code).toBe('RATE_LIMITED');
    });

    it('allows requests again after the 60s window expires', async () => {
      const app = createApp();
      for (let index = 0; index < 20; index++) {
        await app.request('/share', { method: 'POST' });
      }
      const blocked = await app.request('/share', { method: 'POST' });
      expect(blocked.status).toBe(429);

      vi.advanceTimersByTime(61_000);

      const allowed = await app.request('/share', { method: 'POST' });
      expect(allowed.status).toBe(201);
    });
  });

  describe('shareGetIpRateLimit (per-IP, 30/min, UNAUTHENTICATED)', () => {
    function createApp(): Hono<AppEnv> {
      const app = new Hono<AppEnv>();
      app.use('*', async (c, next) => {
        c.env = { NODE_ENV: 'development' } as unknown as AppEnv['Bindings'];
        c.set('redis', redis as unknown as AppEnv['Variables']['redis']);
        await next();
      });
      app.use('*', rateLimitByIp('shareGetIpRateLimit'));
      app.get('/:shareId', (c) => c.json({ shareId: c.req.param('shareId') }));
      return app;
    }

    it('blocks the 31st request from the same IP with 429 RATE_LIMITED', async () => {
      const app = createApp();
      for (let index = 0; index < 30; index++) {
        const res = await app.request('/sh-1', {
          headers: { 'cf-connecting-ip': '1.1.1.1' },
        });
        expect(res.status).toBe(200);
      }
      const blocked = await app.request('/sh-1', {
        headers: { 'cf-connecting-ip': '1.1.1.1' },
      });
      expect(blocked.status).toBe(429);
      const body: ErrorBody = await blocked.json();
      expect(body.code).toBe('RATE_LIMITED');
    });

    it('allows requests again after the 60s window expires', async () => {
      const app = createApp();
      for (let index = 0; index < 30; index++) {
        await app.request('/sh-1', { headers: { 'cf-connecting-ip': '2.2.2.2' } });
      }
      const blocked = await app.request('/sh-1', {
        headers: { 'cf-connecting-ip': '2.2.2.2' },
      });
      expect(blocked.status).toBe(429);

      vi.advanceTimersByTime(61_000);

      const allowed = await app.request('/sh-1', {
        headers: { 'cf-connecting-ip': '2.2.2.2' },
      });
      expect(allowed.status).toBe(200);
    });
  });
});
