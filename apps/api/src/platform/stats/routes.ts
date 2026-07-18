import { Hono } from 'hono';
import { ERROR_CODES } from '@hushbox/shared';
import { defineSliceManifest, routeClass } from '../../middleware/pipeline-manifest.js';
import { rateLimitByIp } from '../../middleware/rate-limit.js';
import { createErrorResponse } from '../../lib/errors/index.js';
import { statsIpRateLimit } from '../../lib/redis/index.js';
import { createPublicStatsStores } from '../../slices/billing/index.js';
import { STATS_CACHE_SCOPE, buildPublicStats } from './pipeline.js';
import type { AppEnv } from '../../middleware/pipeline-manifest.js';
import type { PublicStatsStores } from '../../slices/billing/index.js';

export interface StatsRouteDeps {
  /**
   * Test seam: integration tests inject a counting snapshot-stores fake and a
   * private cache scope (the cache key is global in the shared local Redis).
   * Production passes nothing — the real billing stores and 'global' apply.
   */
  readonly stores?: PublicStatsStores;
  readonly cacheScope?: string;
}

const CDN_MAX_AGE_SECONDS = 3600;

/**
 * Public read-only anonymized usage-stats endpoint (no authentication):
 *
 * - per-IP rate-limited (30 / 60 s) via the edge window enforcer;
 * - cached at the CDN edge for 1 h via `Cache-Control: s-maxage=3600`;
 * - cached in Redis for 1 h via the read-through pipeline;
 * - any failure — including no snapshot row — surfaces as 503
 *   `SERVICE_UNAVAILABLE`; no fallback computation by design.
 */
export function createStatsManifest(deps: StatsRouteDeps = {}) {
  return defineSliceManifest({
    basePath: '/public',
    routes: new Hono<AppEnv>().get(
      '/stats',
      routeClass('public'),
      rateLimitByIp(statsIpRateLimit),
      async (c) => {
        const result = await buildPublicStats({
          stores: deps.stores ?? createPublicStatsStores(),
          db: c.var.db,
          redis: c.var.redis,
          cacheScope: deps.cacheScope ?? STATS_CACHE_SCOPE,
        });
        return result.match(
          (stats) => {
            c.header('Cache-Control', `public, s-maxage=${String(CDN_MAX_AGE_SECONDS)}`);
            return c.json(stats, 200);
          },
          () => c.json(createErrorResponse(ERROR_CODES.SERVICE_UNAVAILABLE), 503)
        );
      }
    ),
  });
}
