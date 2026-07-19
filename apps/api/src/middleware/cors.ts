import { cors as honoCors } from 'hono/cors';
import { matchedRoutes } from 'hono/route';
import { createEnvUtilities } from '@hushbox/shared';
import { readRouteClass } from './pipeline-markers.js';
import type { Context, MiddlewareHandler } from 'hono';
import type { AppEnv, Bindings, RouteClass } from '../lib/context/index.js';

/**
 * The web-origin env vars the CORS allowlist reads. Registry entries
 * (`FRONTEND_URL` and `MARKETING_URL` required in every mode,
 * `FRONTEND_PREVIEW_URL` only in the non-production modes) — typed here as an
 * extension because `assertRequiredBindings` runs after CORS. CORS resolves
 * them itself: the required origins fail fast if absent (a deploy
 * misconfiguration) and the preview origin is included by MODE, never by
 * presence. The marketing origin is allowlisted so its islands' credentialed
 * cross-origin POSTs (newsletter signup/confirm/unsubscribe) clear preflight.
 */
interface CorsBindings extends Bindings {
  FRONTEND_URL?: string;
  FRONTEND_PREVIEW_URL?: string;
  MARKETING_URL?: string;
}

/** Capacitor WebView origins (iOS + Android) — always allowed. */
const CAPACITOR_ORIGINS = ['capacitor://localhost', 'http://localhost'] as const;

/**
 * Reads a web-origin binding the registry defines for the current mode, failing
 * fast on absence — a missing required origin is a deploy misconfiguration, not
 * a state CORS should tolerate by silently shrinking the allowlist.
 */
function requireOrigin(value: string | undefined, name: string): string {
  if (value === undefined || value === '') {
    throw new Error(`${name} must be configured for CORS`);
  }
  return value;
}

/**
 * True when the matched route chain declares exactly the `public` class. The
 * router matches every handler before dispatch, so the declaration is readable
 * even from this first-in-pipeline position (the same mechanism the
 * authorizer uses). Anything ambiguous — no declaration, or conflicting
 * declarations (a composition bug the authorizer will reject) — falls to the
 * stricter allowlist branch.
 */
function isPublicClassed(c: Context<AppEnv>): boolean {
  const declared = new Set<RouteClass>();
  for (const route of matchedRoutes(c)) {
    const cls = readRouteClass(route.handler);
    if (cls !== undefined) declared.add(cls);
  }
  return declared.size === 1 && declared.has('public');
}

/**
 * Class-keyed, ORIGIN-CONDITIONAL CORS. An allowlisted request Origin always
 * gets the credentialed echo grant, REGARDLESS of route class — the web
 * client sends credentials on every call, and browsers hard-reject ACAO `*`
 * on credentialed requests, so app origins must never see the wildcard (that
 * would break credentialed public-classed calls like the pre-session auth
 * endpoints). Only a NON-allowlisted Origin on a route classed exactly
 * `public` (user-agnostic, cacheable payloads) gets
 * `Access-Control-Allow-Origin: *` with NO credentials (the spec forbids
 * credentials with `*`). Because the public branch's response differs by
 * request Origin, it emits `Vary: Origin` — a cache must never serve the
 * `*`-no-credentials variant to an app origin. A public GET is a simple
 * request, so its cross-origin readers need no preflight; OPTIONS matches no
 * classed handler and rides the allowlist branch unchanged. The wildcard
 * branch sets its headers after next(), so a downstream defect (a thrown 500)
 * reaches a non-allowlisted origin without CORS headers — unreadable
 * cross-origin, deliberately fail-closed (the allowlist branch differs:
 * hono/cors sets its grant headers before next()).
 */
export function cors(): MiddlewareHandler<AppEnv> {
  // eslint-disable-next-line unicorn/consistent-function-scoping -- middleware factory pattern
  return async (c, next) => {
    const env: CorsBindings = c.env;
    // CORS runs ahead of the env pipeline stage, so read the mode directly.
    const { isProduction } = createEnvUtilities(c.env);
    const origins = [
      requireOrigin(env.FRONTEND_URL, 'FRONTEND_URL'),
      requireOrigin(env.MARKETING_URL, 'MARKETING_URL'),
      // Preview deploys exist in every non-production mode; production has none.
      ...(isProduction ? [] : [requireOrigin(env.FRONTEND_PREVIEW_URL, 'FRONTEND_PREVIEW_URL')]),
      ...CAPACITOR_ORIGINS,
    ];
    const requestOrigin = c.req.header('Origin');
    const allowlisted = requestOrigin !== undefined && origins.includes(requestOrigin);
    if (!allowlisted && isPublicClassed(c)) {
      await next();
      c.res.headers.set('Access-Control-Allow-Origin', '*');
      c.res.headers.append('Vary', 'Origin');
      return;
    }
    return honoCors({ origin: origins, credentials: true })(c, next);
  };
}
