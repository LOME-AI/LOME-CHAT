import { envConfig } from './env.config.js';
import type { VariableConfig } from './env-types.js';

/**
 * Composes the base `env.config.ts` registry with backend additions layered
 * on top. Same per-mode pattern, no fallback defaults: a variable missing in
 * a mode simply does not exist there and consumers fail fast.
 */
export function composeEnvConfig<
  Base extends Record<string, VariableConfig>,
  Additions extends Record<string, VariableConfig>,
>(base: Base, additions: Additions): Base & Additions {
  const collisions = Object.keys(additions).filter((key) => key in base);
  if (collisions.length > 0) {
    throw new Error(`Env additions collide with base env config keys: ${collisions.join(', ')}`);
  }
  return { ...base, ...additions };
}

/** Backend-only variables. None exist yet; new vars are added here, never to the base file. */
export const envConfigAdditions = {} as const satisfies Record<string, VariableConfig>;

/** The complete composed view: every base entry plus the backend additions. */
export const composedEnvConfig = composeEnvConfig(envConfig, envConfigAdditions);
