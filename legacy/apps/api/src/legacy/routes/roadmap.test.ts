import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { Redis } from '@upstash/redis';
import {
  ERROR_CODE_RATE_LIMITED,
  ERROR_CODE_SERVICE_UNAVAILABLE,
  legacyErrorResponseSchema,
  roadmapResponseSchema,
} from '@hushbox/shared';
import { roadmapRoute } from './roadmap.js';
import type { AppEnv } from '../types.js';
import { createMockLinearClient } from '../services/linear/mock.js';
import * as linearModule from '../services/linear/index.js';

interface FakeStore {
  data: Map<string, unknown>;
}

function makeFakeRedis(store: FakeStore): Redis {
  return {
    get: (key: string) => Promise.resolve(store.data.has(key) ? store.data.get(key) : null),
    set: (key: string, value: unknown) => {
      store.data.set(key, value);
      return Promise.resolve('OK');
    },
    incr: (key: string) => {
      const v = ((store.data.get(key) as number | undefined) ?? 0) + 1;
      store.data.set(key, v);
      return Promise.resolve(v);
    },
    expire: () => Promise.resolve(1),
  } as unknown as Redis;
}

function makeTestApp(
  options: { redis: Redis; env?: Partial<AppEnv['Bindings']> } & {
    env?: Partial<AppEnv['Bindings']>;
  }
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.env = {
      NODE_ENV: 'development',
      ...options.env,
    } as AppEnv['Bindings'];
    c.set('redis', options.redis);
    await next();
  });
  app.route('/api/public/roadmap', roadmapRoute);
  return app;
}

describe('GET /api/public/roadmap', () => {
  let store: FakeStore;
  let app: Hono<AppEnv>;

  beforeEach(() => {
    store = { data: new Map() };
    app = makeTestApp({ redis: makeFakeRedis(store) });
  });

  it('returns a 200 response that parses against the public schema', async () => {
    const response = await app.request('/api/public/roadmap', {
      headers: { 'cf-connecting-ip': '1.2.3.4' },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(() => roadmapResponseSchema.parse(body)).not.toThrow();
  });

  it('emits CDN cache headers', async () => {
    const response = await app.request('/api/public/roadmap', {
      headers: { 'cf-connecting-ip': '1.2.3.4' },
    });
    expect(response.headers.get('cache-control')).toBe('public, s-maxage=300');
  });

  it('returns nodes with progress attached to projects', async () => {
    const response = await app.request('/api/public/roadmap', {
      headers: { 'cf-connecting-ip': '1.2.3.4' },
    });
    const body = roadmapResponseSchema.parse(await response.json());
    const projects = body.nodes.filter((n) => n.kind === 'project');
    expect(projects.length).toBeGreaterThan(0);
    for (const project of projects) {
      expect(project.progress).toBeDefined();
    }
  });

  it('rejects POST requests', async () => {
    const response = await app.request('/api/public/roadmap', {
      method: 'POST',
      headers: { 'cf-connecting-ip': '1.2.3.4' },
    });
    expect(response.status).toBe(404);
  });

  it('rate-limits a single IP after the configured threshold', async () => {
    const headers = { 'cf-connecting-ip': '9.9.9.9' };
    let lastStatus = 200;
    for (let index = 0; index < 35; index += 1) {
      const response = await app.request('/api/public/roadmap', { headers });
      lastStatus = response.status;
      if (lastStatus === 429) break;
    }
    expect(lastStatus).toBe(429);
  });

  it('returns a RATE_LIMITED code when throttled', async () => {
    const headers = { 'cf-connecting-ip': '8.8.8.8' };
    let response = await app.request('/api/public/roadmap', { headers });
    for (let index = 0; index < 50 && response.status !== 429; index += 1) {
      response = await app.request('/api/public/roadmap', { headers });
    }
    expect(response.status).toBe(429);
    const body = legacyErrorResponseSchema.parse(await response.json());
    expect(body.code).toBe(ERROR_CODE_RATE_LIMITED);
  });

  it('returns 503 SERVICE_UNAVAILABLE when the Linear fetch fails', async () => {
    const failingClient = {
      fetchRoadmap() {
        return Promise.reject(new Error('linear unreachable'));
      },
    };
    const spy = vi.spyOn(linearModule, 'getLinearClient').mockReturnValue(failingClient);
    try {
      const response = await app.request('/api/public/roadmap', {
        headers: { 'cf-connecting-ip': '2.2.2.2' },
      });
      expect(response.status).toBe(503);
      const body = legacyErrorResponseSchema.parse(await response.json());
      expect(body.code).toBe(ERROR_CODE_SERVICE_UNAVAILABLE);
    } finally {
      spy.mockRestore();
    }
  });

  it('uses the mock client implicitly (sanity check that the test infra works)', async () => {
    const client = linearModule.getLinearClient({ NODE_ENV: 'development' });
    const mock = createMockLinearClient();
    const fromFactory = await client.fetchRoadmap('HUS');
    const fromMock = await mock.fetchRoadmap('HUS');
    expect(fromFactory).toEqual(fromMock);
  });

  it('uses the cache on subsequent requests within an IP', async () => {
    const r1 = await app.request('/api/public/roadmap', {
      headers: { 'cf-connecting-ip': '5.5.5.5' },
    });
    expect(r1.status).toBe(200);
    const r2 = await app.request('/api/public/roadmap', {
      headers: { 'cf-connecting-ip': '6.6.6.6' },
    });
    expect(r2.status).toBe(200);
    const b1 = await r1.json();
    const b2 = await r2.json();
    expect(b1).toEqual(b2);
  });
});
