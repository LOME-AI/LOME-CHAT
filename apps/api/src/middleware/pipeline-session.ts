import { getIronSession } from 'iron-session';
import { ERROR_CODES } from '@hushbox/shared';
import { derivePrincipal, parseSessionClaims, sessionCookieOptions } from '../lib/context/index.js';
import { createErrorResponse } from '../lib/errors/index.js';
import { markPipelineHandler, readPipelineVariable } from './pipeline-markers.js';
import type { AppEnv, SessionRevocationCheck } from '../lib/context/index.js';
import type { MiddlewareHandler } from 'hono';

// The cookie contract (name, 30-day max age, sealing options) lives in
// lib/context with the claims schema; re-exported here so existing consumers
// of the session stage keep one import site.

export interface PipelineSessionOptions {
  /**
   * Liveness check injected by the composition root (the identity slice owns
   * the implementation; the middleware never imports slice internals). When
   * present it runs on every request with parseable claims: a revoked
   * session degrades to a `none` principal BEFORE authorization, so every
   * authenticated route class rejects it. When the check itself cannot be
   * answered (Redis down) the stage fails closed with 503 — auth never
   * degrades to trusting an unverifiable cookie.
   */
  readonly revocation?: SessionRevocationCheck;
}

/**
 * Pipeline stage 3: principal resolution. Unseals the session cookie,
 * applies the injected revocation check, and derives the request's principal
 * (none / pending-2fa / billing-only / full) for the authorizer. An
 * unreadable or invalid cookie is expected external input and degrades to
 * `none` — never a defect.
 */
export function pipelineSession(options?: PipelineSessionOptions): MiddlewareHandler<AppEnv> {
  return markPipelineHandler(async (c, next) => {
    // The bindings type assumes the bindings stage ran; verify it — the
    // secret below must be the fail-fast-validated one, not a raw env read.
    const bindings = readPipelineVariable(c, 'bindings');
    if (bindings === undefined) {
      throw new Error('pipeline order violated: pipelineSession requires pipelineBindings first.');
    }
    const { isProduction } = c.get('envUtils');
    const session = await getIronSession(
      c.req.raw,
      c.res,
      sessionCookieOptions(bindings.IRON_SESSION_SECRET, isProduction)
    );
    let claims = parseSessionClaims(session);
    if (claims !== null && options?.revocation !== undefined) {
      const redis = readPipelineVariable(c, 'redis');
      if (redis === undefined) {
        throw new Error(
          'pipeline order violated: pipelineSession requires pipelineBindings first.'
        );
      }
      const liveness = await options.revocation(redis, claims);
      if (liveness.isErr()) {
        return c.json(createErrorResponse(ERROR_CODES.UNAVAILABLE), 503);
      }
      if (liveness.value === 'revoked') claims = null;
    }
    c.set('principal', derivePrincipal(claims, Date.now()));
    return next();
  });
}

export { SESSION_COOKIE_NAME } from '../lib/context/index.js';
