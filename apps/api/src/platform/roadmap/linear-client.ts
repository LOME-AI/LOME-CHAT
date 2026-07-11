import { createMockLinearClient } from './linear-mock.js';
import { createRealLinearClient } from './linear-real.js';
import type { EnvUtilities } from '@hushbox/shared';
import type { LinearClient } from './linear-types.js';

/** LINEAR_API_KEY_READ is a registry entry (CiVitest + Production only). */
export interface LinearClientEnv {
  LINEAR_API_KEY_READ?: string;
}

/**
 * The Linear seam's env-mode dispatch (mode, never key presence):
 *
 * - Local dev / E2E: the mock client backed by the committed fixture.
 *   No API key required.
 * - CI integration / production: the real GraphQL client. Requires
 *   `LINEAR_API_KEY_READ` to be present; throws otherwise (fail-fast).
 */
export function getLinearClient(env: LinearClientEnv, envUtilities: EnvUtilities): LinearClient {
  if (envUtilities.isLocalDev || envUtilities.isE2E) {
    return createMockLinearClient();
  }
  if (env.LINEAR_API_KEY_READ === undefined || env.LINEAR_API_KEY_READ === '') {
    throw new Error('LINEAR_API_KEY_READ is required outside dev / E2E');
  }
  return createRealLinearClient(env.LINEAR_API_KEY_READ);
}
