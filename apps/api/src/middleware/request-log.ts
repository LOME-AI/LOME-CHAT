import { matchedRoutes } from 'hono/route';
import { createEnvUtilities } from '@hushbox/shared';
import { readPipelineVariable } from './pipeline-markers.js';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../lib/context/index.js';

/**
 * The matched route TEMPLATE ('/conversations/:id'), never the concrete URL —
 * path tokens and query strings can carry user content (share ids, tokens).
 * The terminal handler's registration path is the last non-wildcard match;
 * a request nothing routed (404) logs the placeholder instead.
 */
function routeTemplate(matched: readonly { path: string }[]): string {
  for (const route of matched.toReversed()) {
    if (route.path !== '*' && route.path !== '/*') return route.path;
  }
  return 'unmatched';
}

/**
 * Dev-only per-request log line through the typed SafeLogFields logger
 * (no-op in production). Runs ahead of the pipeline, so envUtils is built
 * directly (the documented pre-`envMiddleware` pattern) and the logger is
 * read after `next()` — by then the bindings stage has installed it; if a
 * defect kept the pipeline from running there is nothing typed to log with,
 * and the request is skipped rather than logged loosely.
 */
export function requestLog(): MiddlewareHandler<AppEnv> {
  // eslint-disable-next-line unicorn/consistent-function-scoping -- middleware factory pattern
  return async (c, next) => {
    if (createEnvUtilities(c.env).isProduction) {
      return next();
    }
    const startedAt = Date.now();
    await next();
    const logger = readPipelineVariable(c, 'logger');
    if (logger === undefined) return;
    logger.info('request completed', {
      method: c.req.method,
      route: routeTemplate(matchedRoutes(c)),
      statusCode: c.res.status,
      latencyMs: Date.now() - startedAt,
    });
  };
}
