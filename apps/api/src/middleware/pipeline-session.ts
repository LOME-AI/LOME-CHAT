import { getIronSession } from 'iron-session';
import { matchedRoutes } from 'hono/route';
import { ERROR_CODES } from '@hushbox/shared';
import { derivePrincipal, parseSessionClaims, sessionCookieOptions } from '../lib/context/index.js';
import { createErrorResponse } from '../lib/errors/index.js';
import {
  isPipelineHandler,
  markPipelineHandler,
  readPipelineVariable,
  readRouteClass,
} from './pipeline-markers.js';
import type { AppEnv, RouteClass, SessionRevocationCheck } from '../lib/context/index.js';
import type { Context, MiddlewareHandler } from 'hono';

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
 * The route classes an authenticated cookie can authorize: without a
 * revocation check, a revoked or logged-out cookie still admits them. `public`
 * and `dev-only` never consult a live session, so they need no check.
 */
const REVOCATION_GUARDED_CLASSES: ReadonlySet<RouteClass> = new Set([
  'session',
  'pending-2fa',
  'billing-token',
]);

/** True when a matched, non-pipeline handler declares a revocation-guarded class. */
function reachesAuthenticatedRoute(c: Context<AppEnv>): boolean {
  for (const route of matchedRoutes(c)) {
    if (isPipelineHandler(route.handler)) continue;
    const cls = readRouteClass(route.handler);
    if (cls !== undefined && REVOCATION_GUARDED_CLASSES.has(cls)) return true;
  }
  return false;
}

/**
 * The production fail-fast for the silent-omission footgun: a revocation-guarded
 * route reachable in production with no check wired would let revoked and
 * logged-out cookies still authorize. Throws a defect (500) rather than
 * degrading. Checked at first use because slice routes mount after the pipeline.
 */
function assertRevocationWiredInProduction(
  c: Context<AppEnv>,
  options: PipelineSessionOptions | undefined,
  isProduction: boolean
): void {
  if (options?.revocation === undefined && isProduction && reachesAuthenticatedRoute(c)) {
    throw new Error(
      'pipeline misconfigured: an authenticated route class is reachable in production ' +
        'without a session revocation check. Wire PipelineSessionOptions.revocation at the ' +
        'composition root so revoked and logged-out cookies stop authorizing.'
    );
  }
}

/**
 * Pipeline stage 3: principal resolution. Unseals the session cookie,
 * applies the injected revocation check, and derives the request's principal
 * (none / pending-2fa / billing-only / full) for the authorizer. An
 * unreadable or invalid cookie is expected external input and degrades to
 * `none` — never a defect.
 *
 * Omitting the revocation check yields purely cookie-derived principals with
 * no liveness guarantee — safe only for surfaces that mount no authenticated
 * route class. In PRODUCTION that omission is a silent footgun (a revoked
 * cookie would still authorize), so it fails fast at first use of any
 * revocation-guarded route; the check cannot be verified at construction
 * because slice routes mount after the pipeline. Dev/CI/test proceed.
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
    assertRevocationWiredInProduction(c, options, isProduction);
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
