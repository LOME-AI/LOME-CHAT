import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { Redis } from '@upstash/redis';
import { PUBLIC_USAGE_STATS_SCHEMA_VERSION, publicUsageStatsSchema } from '@hushbox/shared';
import { applyPipeline } from '../../middleware/pipeline.js';
import { createRequestDb } from '../../lib/context/index.js';
import { statsCache } from '../../lib/redis/index.js';
import { errAsync, okAsync } from '../../lib/result/index.js';
import { unavailableError } from '../../lib/errors/index.js';
import { createPublicStatsStores } from '../../slices/billing/index.js';
import { createStatsManifest } from './routes.js';
import type { PublicUsageStats } from '@hushbox/shared';
import type { AppEnv, Bindings, RequiredBindings } from '../../lib/context/index.js';
import type { TelemetryEnv } from '../../lib/telemetry/index.js';
import type { PublicStatsSnapshotRow, PublicStatsStores } from '../../slices/billing/index.js';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is required for stats route integration tests`);
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

function validStats(): PublicUsageStats {
  return {
    schemaVersion: PUBLIC_USAGE_STATS_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    modalities: {
      text: {
        all: {
          models: [
            {
              modelId: 'openai/gpt-5',
              displayName: 'GPT-5',
              provider: 'OpenAI',
              sharePercent: 62.5,
              deltaPoints: null,
              avgCostUsd: '0.0051',
            },
          ],
          others: { sharePercent: 37.5, deltaPoints: null },
          trend: { bucket: 'month', points: [] },
          cost: { avgUsd: '0.004', medianUsd: '0.003', p90Usd: '0.009' },
        },
      },
    },
  };
}

function snapshotRow(stats: unknown): PublicStatsSnapshotRow {
  return {
    id: crypto.randomUUID(),
    schemaVersion: PUBLIC_USAGE_STATS_SCHEMA_VERSION,
    stats,
    createdAt: new Date(),
  };
}

/**
 * A counting stores fake at the manifest's test seam (production passes
 * nothing and the real billing stores + `c.var.db` apply). Only the read the
 * route exercises is live; every other member throws if reached.
 */
function fakeStores(options: { row?: PublicStatsSnapshotRow | null; fail?: boolean }): {
  stores: PublicStatsStores;
  reads: () => number;
} {
  let reads = 0;
  const unreachable = (): never => {
    throw new Error('unreachable store member for GET /public/stats');
  };
  return {
    stores: {
      aggregateGlobalUsageByModel: unreachable,
      readGlobalCostPercentiles: unreachable,
      readGlobalTrendCounts: unreachable,
      insertPublicStatsSnapshot: unreachable,
      readLatestPublicStatsSnapshot: () => {
        reads += 1;
        if (options.fail === true) return errAsync(unavailableError('db down'));
        return okAsync(options.row ?? null);
      },
    },
    reads: () => reads,
  };
}

function buildApp(stores: PublicStatsStores, cacheScope: string): Hono<AppEnv> {
  const manifest = createStatsManifest({ stores, cacheScope });
  const app = applyPipeline(new Hono<AppEnv>());
  app.route(manifest.basePath, manifest.routes);
  return app;
}

/** Unique per-call identities so the shared Redis never couples tests. */
function uniqueCacheScope(): string {
  return `stats-test-${crypto.randomUUID().slice(0, 12)}`;
}

function uniqueIpHeaders(): Record<string, string> {
  return { 'cf-connecting-ip': `203.0.113.9-${crypto.randomUUID()}` };
}

async function getStats(app: Hono<AppEnv>, headers: Record<string, string>): Promise<Response> {
  return app.request('/public/stats', { headers }, testEnv);
}

describe('GET /public/stats', () => {
  it('serves the latest matching-version snapshot payload with the CDN cache header', async () => {
    const stats = validStats();
    const fake = fakeStores({ row: snapshotRow(stats) });
    const res = await getStats(buildApp(fake.stores, uniqueCacheScope()), uniqueIpHeaders());
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, s-maxage=3600');
    expect(await readJson<PublicUsageStats>(res)).toEqual(stats);
  });

  it('serves the second call from the Redis cache without hitting the snapshot store', async () => {
    const cacheScope = uniqueCacheScope();
    const stats = validStats();
    const fake = fakeStores({ row: snapshotRow(stats) });
    const app = buildApp(fake.stores, cacheScope);

    const first = await getStats(app, uniqueIpHeaders());
    expect(first.status).toBe(200);
    const second = await getStats(app, uniqueIpHeaders());
    expect(second.status).toBe(200);
    expect(fake.reads()).toBe(1);
    expect(await second.json()).toEqual(await first.json());

    const key = statsCache.buildKey(cacheScope, PUBLIC_USAGE_STATS_SCHEMA_VERSION);
    expect(await redis.get(key)).not.toBeNull();
    expect(await redis.ttl(key)).toBeGreaterThan(3000);
  });

  it('answers 503 SERVICE_UNAVAILABLE when no snapshot row exists (no fallback computation)', async () => {
    const fake = fakeStores({ row: null });
    const res = await getStats(buildApp(fake.stores, uniqueCacheScope()), uniqueIpHeaders());
    expect(res.status).toBe(503);
    // Errors must never carry the CDN cache header — a cached 503 would pin
    // the outage at the edge for an hour.
    expect(res.headers.get('Cache-Control')).toBeNull();
    expect(await res.json()).toEqual({ code: 'SERVICE_UNAVAILABLE' });
  });

  it('answers 503 when the snapshot store read fails', async () => {
    const fake = fakeStores({ fail: true });
    const res = await getStats(buildApp(fake.stores, uniqueCacheScope()), uniqueIpHeaders());
    expect(res.status).toBe(503);
    expect(res.headers.get('Cache-Control')).toBeNull();
    expect(await res.json()).toEqual({ code: 'SERVICE_UNAVAILABLE' });
  });

  it('answers 503 when the stored payload fails the public schema', async () => {
    const fake = fakeStores({ row: snapshotRow({ not: 'a valid payload' }) });
    const res = await getStats(buildApp(fake.stores, uniqueCacheScope()), uniqueIpHeaders());
    expect(res.status).toBe(503);
    expect(res.headers.get('Cache-Control')).toBeNull();
    expect(await res.json()).toEqual({ code: 'SERVICE_UNAVAILABLE' });
  });

  it('falls back to the real billing stores and global scope when no deps are injected', async () => {
    // Seed one real snapshot row so the shared-DB path is deterministic; the
    // endpoint serves the LATEST matching row, which may be a later writer's —
    // assert shape, not identity.
    const seed = await createPublicStatsStores().insertPublicStatsSnapshot(
      createRequestDb(testEnv as RequiredBindings, { isDev: true }),
      { schemaVersion: PUBLIC_USAGE_STATS_SCHEMA_VERSION, stats: validStats() }
    );
    expect(seed.isOk()).toBe(true);

    const manifest = createStatsManifest();
    const app = applyPipeline(new Hono<AppEnv>());
    app.route(manifest.basePath, manifest.routes);
    const res = await app.request('/public/stats', { headers: uniqueIpHeaders() }, testEnv);
    expect(res.status).toBe(200);
    const body = await readJson<unknown>(res);
    expect(publicUsageStatsSchema.safeParse(body).success).toBe(true);
  });

  it('rate-limits the 31st request in a minute from one IP with 429', async () => {
    const fake = fakeStores({ row: snapshotRow(validStats()) });
    const app = buildApp(fake.stores, uniqueCacheScope());
    const headers = uniqueIpHeaders();

    for (let call = 0; call < 30; call += 1) {
      const res = await getStats(app, headers);
      expect(res.status).toBe(200);
    }
    const blocked = await getStats(app, headers);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Cache-Control')).toBeNull();
    const body = await readJson<{ code: string }>(blocked);
    expect(body.code).toBe('RATE_LIMITED');
  });
});
