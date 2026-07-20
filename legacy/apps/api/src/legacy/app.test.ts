import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { createApp } from './app.js';

const mockDbFrom = {
  where: vi.fn(() => Promise.resolve([])),
  innerJoin: vi.fn(() => ({
    where: vi.fn(() => Promise.resolve([{ count: 0 }])),
  })),
};

vi.mock('@hushbox/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/db')>();
  return {
    ...actual,
    createDb: vi.fn(() => ({
      select: vi.fn(() => ({ from: vi.fn(() => mockDbFrom) })),
    })),
    LOCAL_NEON_DEV_CONFIG: {},
  };
});

vi.mock('./services/billing/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./services/billing/index.js')>();
  return {
    ...actual,
    consumeTrialMessage: vi.fn(() => Promise.resolve({ canSend: true, messageCount: 1, limit: 5 })),
  };
});

describe('createApp', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-15T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates a new app instance', () => {
    const app = createApp();
    expect(app).toBeDefined();
  });

  describe('health route', () => {
    it('responds to GET /api/health', async () => {
      const app = createApp();
      const res = await app.request('/api/health');

      expect(res.status).toBe(200);
      const body: { status: string; timestamp: string } = await res.json();
      expect(body.status).toBe('ok');
      expect(body.timestamp).toBe('2024-01-15T12:00:00.000Z');
    });
  });

  describe('request log middleware', () => {
    it('emits a [req] line for each request in dev mode', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const app = createApp();
        await app.request('/api/health');

        const reqLines = consoleSpy.mock.calls.filter(
          (call) => typeof call[0] === 'string' && call[0].startsWith('[req] ')
        );
        expect(reqLines.length).toBeGreaterThanOrEqual(1);
        expect(reqLines[0]?.[0]).toContain(' GET /api/health 200 ');
      } finally {
        consoleSpy.mockRestore();
      }
    });
  });

  describe('auth routes', () => {
    it('responds to /api/auth/* requests', async () => {
      const app = createApp();
      const res = await app.request('/api/auth/me');
      expect(res.status).toBeDefined();
    });
  });

  describe('conversations routes', () => {
    const routeEnv = {
      DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
      NODE_ENV: 'development',
      UPSTASH_REDIS_REST_URL: 'http://localhost:8079',
      UPSTASH_REDIS_REST_TOKEN: 'test-token',
    };

    it('returns 401 for GET /api/conversations without auth', async () => {
      const app = createApp();
      const res = await app.request('/api/conversations', {}, routeEnv);

      expect(res.status).toBe(401);
      const body: { code: string } = await res.json();
      expect(body.code).toBe('NOT_AUTHENTICATED');
    });

    it('returns 401 for GET /api/conversations/:id without auth', async () => {
      const app = createApp();
      const res = await app.request('/api/conversations/123', {}, routeEnv);

      expect(res.status).toBe(401);
      const body: { code: string } = await res.json();
      expect(body.code).toBe('NOT_AUTHENTICATED');
    });

    it('returns 401 for POST /api/conversations without auth', async () => {
      const app = createApp();
      const res = await app.request('/api/conversations', { method: 'POST' }, routeEnv);

      expect(res.status).toBe(401);
      const body: { code: string } = await res.json();
      expect(body.code).toBe('NOT_AUTHENTICATED');
    });

    it('returns 401 for DELETE /api/conversations/:id without auth', async () => {
      const app = createApp();
      const res = await app.request('/api/conversations/123', { method: 'DELETE' }, routeEnv);

      expect(res.status).toBe(401);
      const body: { code: string } = await res.json();
      expect(body.code).toBe('NOT_AUTHENTICATED');
    });

    it('returns 401 for PATCH /api/conversations/:id without auth', async () => {
      const app = createApp();
      const res = await app.request('/api/conversations/123', { method: 'PATCH' }, routeEnv);

      expect(res.status).toBe(401);
      const body: { code: string } = await res.json();
      expect(body.code).toBe('NOT_AUTHENTICATED');
    });
  });

  describe('chat routes', () => {
    it('returns 401 for POST /api/chat/stream without auth', async () => {
      const app = createApp();
      const res = await app.request(
        '/api/chat/stream',
        { method: 'POST' },
        {
          DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
          NODE_ENV: 'development',
          UPSTASH_REDIS_REST_URL: 'http://localhost:8079',
          UPSTASH_REDIS_REST_TOKEN: 'test-token',
        }
      );

      expect(res.status).toBe(401);
      const body: { code: string } = await res.json();
      expect(body.code).toBe('NOT_AUTHENTICATED');
    });
  });

  describe('security headers', () => {
    it('includes security headers on all responses', async () => {
      const app = createApp();
      const res = await app.request('/api/health');

      expect(res.headers.get('Content-Security-Policy')).toBeDefined();
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(res.headers.get('X-Frame-Options')).toBe('DENY');
      expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
    });
  });

  describe('CSRF protection', () => {
    it('rejects POST to /api/conversations with wrong Origin', async () => {
      const app = createApp();
      const res = await app.request(
        '/api/conversations',
        {
          method: 'POST',
          headers: {
            Origin: 'https://evil.com',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({}),
        },
        {
          DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
          NODE_ENV: 'development',
          FRONTEND_URL: 'http://localhost:5173',
        }
      );

      expect(res.status).toBe(403);
      const body: { code: string } = await res.json();
      expect(body.code).toBe('CSRF_REJECTED');
    });

    it('rejects POST to /api/billing/payments with wrong Origin', async () => {
      const app = createApp();
      const res = await app.request(
        '/api/billing/payments',
        {
          method: 'POST',
          headers: {
            Origin: 'https://evil.com',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({}),
        },
        {
          DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
          NODE_ENV: 'development',
          FRONTEND_URL: 'http://localhost:5173',
        }
      );

      expect(res.status).toBe(403);
      const body: { code: string } = await res.json();
      expect(body.code).toBe('CSRF_REJECTED');
    });

    it('rejects POST to /api/chat/stream with wrong Origin', async () => {
      const app = createApp();
      const res = await app.request(
        '/api/chat/stream',
        {
          method: 'POST',
          headers: {
            Origin: 'https://evil.com',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({}),
        },
        {
          DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
          NODE_ENV: 'development',
          FRONTEND_URL: 'http://localhost:5173',
        }
      );

      expect(res.status).toBe(403);
      const body: { code: string } = await res.json();
      expect(body.code).toBe('CSRF_REJECTED');
    });

    it('allows GET requests regardless of Origin', async () => {
      const app = createApp();
      const res = await app.request('/api/health', {
        headers: { Origin: 'https://evil.com' },
      });

      expect(res.status).toBe(200);
    });
  });

  describe('CORS', () => {
    it('includes CORS headers for allowed origin', async () => {
      const app = createApp();
      const res = await app.request(
        '/api/health',
        { headers: { Origin: 'http://localhost:5173' } },
        { FRONTEND_URL: 'http://localhost:5173' }
      );

      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
    });
  });

  describe('members routes', () => {
    const membersEnv = {
      DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
      NODE_ENV: 'development',
      UPSTASH_REDIS_REST_URL: 'http://localhost:8079',
      UPSTASH_REDIS_REST_TOKEN: 'test-token',
    };

    it('returns 401 for GET /api/members/some-conv-id without auth', async () => {
      const app = createApp();
      const res = await app.request('/api/members/some-conv-id', {}, membersEnv);

      expect(res.status).toBe(401);
      const body: { code: string } = await res.json();
      expect(body.code).toBe('NOT_AUTHENTICATED');
    });
  });

  describe('links routes', () => {
    const linksEnv = {
      DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
      NODE_ENV: 'development',
      UPSTASH_REDIS_REST_URL: 'http://localhost:8079',
      UPSTASH_REDIS_REST_TOKEN: 'test-token',
    };

    it('returns 401 for GET /api/links/some-conv-id without auth', async () => {
      const app = createApp();
      const res = await app.request('/api/links/some-conv-id', {}, linksEnv);

      expect(res.status).toBe(401);
      const body: { code: string } = await res.json();
      expect(body.code).toBe('NOT_AUTHENTICATED');
    });
  });

  describe('message share routes', () => {
    const messagesEnv = {
      DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
      NODE_ENV: 'development',
      UPSTASH_REDIS_REST_URL: 'http://localhost:8079',
      UPSTASH_REDIS_REST_TOKEN: 'test-token',
    };

    it('returns 401 for POST /api/messages/share without auth', async () => {
      const app = createApp();
      const res = await app.request('/api/messages/share', { method: 'POST' }, messagesEnv);

      expect(res.status).toBe(401);
      const body: { code: string } = await res.json();
      expect(body.code).toBe('NOT_AUTHENTICATED');
    });
  });

  describe('error handling', () => {
    it('returns 404 for unknown routes', async () => {
      const app = createApp();
      const res = await app.request('/unknown-route');

      expect(res.status).toBe(404);
    });
  });

  describe('trial routes', () => {
    const trialEnv = {
      DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
      NODE_ENV: 'development',
      UPSTASH_REDIS_REST_URL: 'http://localhost:8079',
      UPSTASH_REDIS_REST_TOKEN: 'test-token',
      AI_GATEWAY_API_KEY: 'test-key',
      PUBLIC_MODELS_URL: 'https://test.example/v1/models',
      R2_S3_ENDPOINT: 'http://localhost:9000',
      R2_ACCESS_KEY_ID: 'minioadmin',
      R2_SECRET_ACCESS_KEY: 'minioadmin',
      R2_BUCKET_MEDIA: 'hushbox-media-dev',
    };

    it('does not return 500 for POST /api/trial/stream with valid body', async () => {
      // Mock fetch to satisfy two callers in this request lifecycle:
      // 1. The Upstash Redis client (rate-limit middleware uses a pipeline,
      //    which expects a top-level array with `{result, error}` per command).
      // 2. The AI Gateway model fetcher (expects a `{data: []}` JSON shape).
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation((input: string | URL | Request) => {
          const url = input instanceof Request ? input.url : String(input);
          if (url.startsWith(trialEnv.UPSTASH_REDIS_REST_URL)) {
            // Pipeline: array of `{result, error}`. We claim every rate-limit
            // hit returns null (under cap) so the middleware lets the request
            // through to the route handler.
            return Promise.resolve(
              Response.json([{ result: null }], {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              })
            );
          }
          return Promise.resolve(
            Response.json(
              { data: [] },
              {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              }
            )
          );
        });

      try {
        const app = createApp();
        const res = await app.request(
          '/api/trial/stream',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              messages: [{ role: 'user', content: 'hello' }],
              model: 'openai/gpt-4o-mini',
            }),
          },
          trialEnv
        );

        expect(res.status).not.toBe(500);
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });

  describe('dev routes', () => {
    it('responds to GET /api/dev/personas in development', async () => {
      const app = createApp();
      const res = await app.request(
        '/api/dev/personas',
        {},
        {
          DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
          NODE_ENV: 'development',
          UPSTASH_REDIS_REST_URL: 'http://localhost:8079',
          UPSTASH_REDIS_REST_TOKEN: 'test-token',
        }
      );

      expect(res.status).toBe(200);
      const body: { personas: unknown[] } = await res.json();
      expect(body).toHaveProperty('personas');
      expect(Array.isArray(body.personas)).toBe(true);
    });
  });
});
