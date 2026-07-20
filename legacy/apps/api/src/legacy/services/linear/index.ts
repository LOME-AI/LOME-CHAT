import { createEnvUtilities, type EnvContext } from '@hushbox/shared';
import { createMockLinearClient } from './mock.js';
import { createRealLinearClient } from './real.js';
import type { LinearClient } from './types.js';

export type {
  LinearClient,
  LinearIssue,
  LinearIssueStateType,
  LinearProject,
  LinearProjectStateType,
  LinearRelation,
  LinearRelationKind,
  LinearRoadmapData,
} from './types.js';

export { LinearApiError } from './real.js';

interface LinearClientEnv extends EnvContext {
  LINEAR_API_KEY_READ?: string;
}

/**
 * Get the appropriate Linear client based on environment.
 *
 * - Local dev / E2E: Returns the mock client backed by the fixture in
 *   `mock-fixtures/roadmap.ts`. No API key required.
 * - CI integration / production: Returns the real GraphQL client. Requires
 *   `LINEAR_API_KEY_READ` to be present; throws otherwise (fail-fast).
 *
 * Mirrors `getAIClient` at apps/api/src/services/ai/index.ts:67.
 */
export function getLinearClient(env: LinearClientEnv): LinearClient {
  const { isLocalDev, isE2E } = createEnvUtilities(env);
  if (isLocalDev || isE2E) {
    return createMockLinearClient();
  }
  if (env.LINEAR_API_KEY_READ === undefined || env.LINEAR_API_KEY_READ === '') {
    throw new Error('LINEAR_API_KEY_READ required outside dev / E2E');
  }
  return createRealLinearClient(env.LINEAR_API_KEY_READ);
}
