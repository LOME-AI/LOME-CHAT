import { Redis } from '@upstash/redis';
import { createDb, LOCAL_NEON_DEV_CONFIG } from '@hushbox/db';
import type { Database } from '@hushbox/db';
import type { RequiredBindings } from './app-env.js';

/**
 * Per-request client factories (serverless mindset: no module-level
 * singletons; state lives in Postgres/Redis, never the isolate). Callers
 * depend on this seam, not on the @hushbox/db client module directly.
 */
export function createRequestDb(
  bindings: RequiredBindings,
  envUtilities: { readonly isDev: boolean }
): Database {
  return envUtilities.isDev
    ? createDb(bindings.DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG })
    : createDb(bindings.DATABASE_URL);
}

export function createRequestRedis(bindings: RequiredBindings): Redis {
  return new Redis({
    url: bindings.UPSTASH_REDIS_REST_URL,
    token: bindings.UPSTASH_REDIS_REST_TOKEN,
  });
}
