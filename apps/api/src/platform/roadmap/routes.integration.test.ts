import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { Redis } from '@upstash/redis';
import { applyPipeline } from '../../middleware/pipeline.js';
import { roadmapCache } from '../../lib/redis/index.js';
import { ROADMAP_SCHEMA_VERSION } from './pipeline.js';
import { createRoadmapManifest } from './routes.js';
import { MOCK_ISSUES, MOCK_PROJECTS } from './mock-roadmap-fixture.js';
import type { AppEnv, Bindings } from '../../lib/context/index.js';
import type { TelemetryEnv } from '../../lib/telemetry/index.js';
import type { LinearClient, LinearRoadmapData } from './linear-types.js';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is required for roadmap route integration tests`);
  }
  return value;
}

/** Typed JSON read severed from hono's Response inference (json() is unknown here). */
async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

const testEnv: Bindings & TelemetryEnv = {
  NODE_ENV: 'development',
  DATABASE_URL: requiredEnv('DATABASE_URL'),
  UPSTASH_REDIS_REST_URL: requiredEnv('UPSTASH_REDIS_REST_URL'),
  UPSTASH_REDIS_REST_TOKEN: requiredEnv('UPSTASH_REDIS_REST_TOKEN'),
  IRON_SESSION_SECRET: 'secret-at-least-32-characters-long!!',
  TELEMETRY_SINKS: 'console',
};

const redis = new Redis({
  url: testEnv.UPSTASH_REDIS_REST_URL ?? '',
  token: testEnv.UPSTASH_REDIS_REST_TOKEN ?? '',
});

/** A counting Linear fake; `fail` makes every fetch throw. */
function fakeLinear(options: { fail?: boolean; issueCount?: number } = {}): {
  client: LinearClient;
  calls: () => number;
} {
  let calls = 0;
  return {
    client: {
      fetchRoadmap: (): Promise<LinearRoadmapData> => {
        calls += 1;
        if (options.fail === true) throw new Error('linear down');
        if (options.issueCount !== undefined) {
          return Promise.resolve({
            projects: MOCK_PROJECTS,
            issues: Array.from({ length: options.issueCount }, (_, index) => ({
              id: `mass-${String(index)}`,
              title: `Issue ${String(index)}`,
              stateName: 'Todo',
              stateType: 'unstarted' as const,
              labelNames: ['type:feature'],
              parentId: null,
              projectId: null,
              relations: [],
            })),
          });
        }
        return Promise.resolve({ projects: MOCK_PROJECTS, issues: MOCK_ISSUES });
      },
    },
    calls: () => calls,
  };
}

function buildApp(linear: LinearClient, teamKey: string): Hono<AppEnv> {
  const manifest = createRoadmapManifest({ linear, teamKey });
  const app = applyPipeline(new Hono<AppEnv>());
  app.route(manifest.basePath, manifest.routes);
  return app;
}

/** Unique per-call identities so the shared Redis never couples tests. */
function uniqueTeamKey(): string {
  return `hus-test-${crypto.randomUUID().slice(0, 12)}`;
}

function uniqueIpHeaders(): Record<string, string> {
  return { 'cf-connecting-ip': `203.0.113.9-${crypto.randomUUID()}` };
}

async function getRoadmap(app: Hono<AppEnv>, headers: Record<string, string>): Promise<Response> {
  return app.request('/public/roadmap', { headers }, testEnv);
}

describe('GET /public/roadmap', () => {
  it('serves the normalized public shape with the CDN cache header', async () => {
    const linear = fakeLinear();
    const res = await getRoadmap(buildApp(linear.client, uniqueTeamKey()), uniqueIpHeaders());
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, s-maxage=300');
    const body = await readJson<{ nodes: { id: string; kind: string }[] }>(res);
    expect(body.nodes.length).toBeGreaterThan(0);
    // Opaque ids only — no raw mock-prefixed Linear id may leak.
    expect(body.nodes.every((node) => /^[0-9a-f]{12}$/.test(node.id))).toBe(true);
  });

  it('serves the second call from the Redis cache without calling Linear', async () => {
    const teamKey = uniqueTeamKey();
    const linear = fakeLinear();
    const app = buildApp(linear.client, teamKey);

    const first = await getRoadmap(app, uniqueIpHeaders());
    expect(first.status).toBe(200);
    const second = await getRoadmap(app, uniqueIpHeaders());
    expect(second.status).toBe(200);
    expect(linear.calls()).toBe(1);
    expect(await second.json()).toEqual(await first.json());

    const cached = await redis.get(roadmapCache.buildKey(teamKey, ROADMAP_SCHEMA_VERSION));
    expect(cached).not.toBeNull();
    const ttl = await redis.ttl(roadmapCache.buildKey(teamKey, ROADMAP_SCHEMA_VERSION));
    expect(ttl).toBeGreaterThan(3000);
  });

  it('answers 503 SERVICE_UNAVAILABLE when Linear fails (no stale fallback)', async () => {
    const linear = fakeLinear({ fail: true });
    const res = await getRoadmap(buildApp(linear.client, uniqueTeamKey()), uniqueIpHeaders());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: 'SERVICE_UNAVAILABLE' });
  });

  it('answers 503 when the normalized response fails the public schema (>500 nodes)', async () => {
    const linear = fakeLinear({ issueCount: 501 });
    const res = await getRoadmap(buildApp(linear.client, uniqueTeamKey()), uniqueIpHeaders());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: 'SERVICE_UNAVAILABLE' });
  });

  it('falls back to the env-mode Linear client and HUS team when no deps are injected', async () => {
    // Local-dev mode resolves the mock client; the response is the committed
    // fixture under the real 'roadmap:hus:<version>' cache key.
    const manifest = createRoadmapManifest();
    const app = applyPipeline(new Hono<AppEnv>());
    app.route(manifest.basePath, manifest.routes);
    const res = await app.request('/public/roadmap', { headers: uniqueIpHeaders() }, testEnv);
    expect(res.status).toBe(200);
    const body = await readJson<{ nodes: unknown[] }>(res);
    expect(body.nodes.length).toBeGreaterThan(0);
  });

  it('rate-limits the 31st request in a minute from one IP with 429', async () => {
    const linear = fakeLinear();
    const app = buildApp(linear.client, uniqueTeamKey());
    const headers = uniqueIpHeaders();

    for (let call = 0; call < 30; call += 1) {
      const res = await getRoadmap(app, headers);
      expect(res.status).toBe(200);
    }
    const blocked = await getRoadmap(app, headers);
    expect(blocked.status).toBe(429);
    const body = await readJson<{ code: string }>(blocked);
    expect(body.code).toBe('RATE_LIMITED');
  });
});
