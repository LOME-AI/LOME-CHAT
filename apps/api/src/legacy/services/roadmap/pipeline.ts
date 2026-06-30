import { roadmapResponseSchema, type RoadmapResponse } from '@hushbox/shared';
import { normalizeRoadmap } from './normalize.js';
import type { LinearClient } from '../linear/index.js';
import type { RoadmapCache } from './cache.js';

const TEAM_KEY = 'HUS';

/**
 * Orchestrate the full roadmap pipeline. On cache miss this fetches
 * Linear, normalizes the data into our opaque node list, validates the
 * response shape, and writes it to Redis. On cache hit it returns the
 * cached value untouched.
 *
 * Throws on Linear failures — the caller maps thrown errors to a 503.
 */
export async function buildRoadmap(
  linear: LinearClient,
  cache: RoadmapCache
): Promise<RoadmapResponse> {
  const cached = await cache.get();
  if (cached !== null) return cached;

  const linearData = await linear.fetchRoadmap(TEAM_KEY);
  const graph = await normalizeRoadmap(linearData);

  const response: RoadmapResponse = roadmapResponseSchema.parse({
    nodes: graph.nodes,
  });

  await cache.set(response);
  return response;
}
