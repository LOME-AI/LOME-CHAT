import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../types.js';

/**
 * Dev-only per-request logger. Emits one line per request via console.log,
 * which wrangler dev forwards to its stdout — the tee in scripts/wrangler-dev.ts
 * captures that into apps/api/.wrangler-<port>.log for post-hoc debugging.
 *
 * Line shape:
 *   [req] <iso> <METHOD> <path> <status> <ms>ms v=<X-App-Version|none>
 *
 * The v= field is what scripts/lib/extract-mobile-api-log.ts uses to
 * separate APK traffic from sibling sessions (browser, e2e) sharing the API.
 */
export function requestLog(): MiddlewareHandler<AppEnv> {
  // eslint-disable-next-line unicorn/consistent-function-scoping -- middleware factory pattern
  return async (c, next) => {
    if (c.get('envUtils').isProduction) {
      await next();
      return;
    }

    const startedAt = Date.now();
    const method = c.req.method;
    // Logging path (not full URL) on purpose: query strings can carry
    // user-supplied content (recovery tokens, share IDs, search text) we
    // don't want in a captured artifact, and they don't help distinguish
    // mobile vs sibling-session traffic — that's what v= already does.
    const path = c.req.path;
    const version = c.req.header('X-App-Version') ?? 'none';

    await next();

    const status = c.res.status;
    const durationMs = Date.now() - startedAt;
    // eslint-disable-next-line no-console -- emits one structured request line per call; wrangler dev's stdout (captured by the tee in scripts/wrangler-dev.ts) is the transport that makes this observable in maestro-results.
    console.log(
      `[req] ${new Date(startedAt).toISOString()} ${method} ${path} ${String(status)} ${String(durationMs)}ms v=${version}`
    );
  };
}
