import { Hono } from 'hono';
import { ERROR_CODES } from '@hushbox/shared';
import { defineSliceManifest, routeClass } from '../../middleware/pipeline-manifest.js';
import { rateLimitByIp } from '../../middleware/rate-limit.js';
import { createErrorResponse } from '../../lib/errors/index.js';
import { roadmapIpRateLimit } from '../../lib/redis/index.js';
import { getLinearClient } from './linear-client.js';
import { buildRoadmap } from './pipeline.js';
import type { AppEnv } from '../../middleware/pipeline-manifest.js';
import type { Bindings } from '../../lib/context/index.js';
import type { LinearClient } from './linear-types.js';

/** LINEAR_API_KEY_READ is a per-consumer binding (not pipeline-gated). */
interface RoadmapBindings extends Bindings {
  LINEAR_API_KEY_READ?: string;
}

const TEAM_KEY = 'HUS';
const CDN_MAX_AGE_SECONDS = 300;

export interface RoadmapRouteDeps {
  /**
   * Test seam: integration tests inject a fake Linear client and a private
   * team key (the cache key is global in the shared local Redis). Production
   * passes nothing — the env-mode factory and 'HUS' apply.
   */
  readonly linear?: LinearClient;
  readonly teamKey?: string;
}

/**
 * Public read-only roadmap endpoint (no authentication):
 *
 * - per-IP rate-limited (30 / 60 s) via the edge window enforcer;
 * - cached at the CDN edge for 5 min via `Cache-Control: s-maxage=300`;
 * - cached in Redis for 1 h via the read-through pipeline;
 * - any failure surfaces as 503 `SERVICE_UNAVAILABLE`; no stale fallback
 *   by design.
 */
export function createRoadmapManifest(deps: RoadmapRouteDeps = {}) {
  return defineSliceManifest({
    basePath: '/public',
    routes: new Hono<AppEnv>().get(
      '/roadmap',
      routeClass('public'),
      rateLimitByIp(roadmapIpRateLimit),
      async (c) => {
        const env: RoadmapBindings = c.env;
        const linear = deps.linear ?? getLinearClient(env, c.var.envUtils);
        const result = await buildRoadmap({
          linear,
          redis: c.var.redis,
          teamKey: deps.teamKey ?? TEAM_KEY,
        });
        return result.match(
          (response) => {
            c.header('Cache-Control', `public, s-maxage=${String(CDN_MAX_AGE_SECONDS)}`);
            return c.json(response, 200);
          },
          () => c.json(createErrorResponse(ERROR_CODES.SERVICE_UNAVAILABLE), 503)
        );
      }
    ),
  });
}
