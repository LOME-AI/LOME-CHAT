import { matchedRoutes } from 'hono/route';
import { DOMAIN_ERROR_CODE_TO_WIRE_CODE } from '@hushbox/shared';
import { authorizeAccess } from '../lib/context/index.js';
import { createErrorResponse } from '../lib/errors/index.js';
import {
  isPipelineHandler,
  markPipelineHandler,
  readPipelineVariable,
  readRouteClass,
} from './pipeline-markers.js';
import type { ErrorCode } from '@hushbox/shared';
import type { DomainErrorCode } from '../lib/errors/index.js';
import type { AppEnv, RouteClass } from '../lib/context/index.js';
import type { Context, MiddlewareHandler } from 'hono';

/**
 * Completeness witness at the map's consumption seam: every DomainErrorCode
 * must have a wire mapping (the compile-time guarantee the shared map's doc
 * comment promises). A new taxonomy code without a wire code fails here.
 */
const WIRE_CODE_BY_DOMAIN_CODE = DOMAIN_ERROR_CODE_TO_WIRE_CODE satisfies Record<
  DomainErrorCode,
  ErrorCode
>;

interface DeclaredClassResolution {
  readonly routeClass: RouteClass | undefined;
  readonly matchedUndeclaredHandler: boolean;
}

/**
 * Resolves the route-class declaration from the request's matched handler
 * chain. The router has already matched every handler (middleware and
 * terminal) when the pipeline runs, so the declaration is readable BEFORE the
 * terminal handler executes. Conflicting declarations are a composition bug —
 * a thrown defect, not a client error.
 */
function resolveDeclaredClass(c: Context<AppEnv>): DeclaredClassResolution {
  const declared = new Set<RouteClass>();
  let matchedUndeclaredHandler = false;
  for (const route of matchedRoutes(c)) {
    if (isPipelineHandler(route.handler)) continue;
    const cls = readRouteClass(route.handler);
    if (cls === undefined) {
      matchedUndeclaredHandler = true;
    } else {
      declared.add(cls);
    }
  }
  if (declared.size > 1) {
    throw new Error(
      `pipeline: conflicting route classes on one request: ${[...declared].join(', ')}`
    );
  }
  return { routeClass: [...declared][0], matchedUndeclaredHandler };
}

/**
 * Pipeline stage 5: DEFAULT-DENY route-class enforcement — the single
 * authorization gate for everything mounted under the app. A denied handler
 * never runs; there is no post-hoc response masking. Resolution:
 *
 * - exactly one declared class → enforce the authorization matrix;
 * - a matched route with NO declaration → denied (403), even for a full
 *   session — undeclared is a misconfiguration, and the gate fails closed;
 * - nothing matched beyond the pipeline itself → fall through to Hono's 404.
 */
export function pipelineAuthorize(): MiddlewareHandler<AppEnv> {
  return markPipelineHandler(async (c, next) => {
    // The principal and envUtils types assume the earlier stages ran; verify
    // it — authorization with a missing principal must be a loud defect.
    const principal = readPipelineVariable(c, 'principal');
    const envUtilities = readPipelineVariable(c, 'envUtils');
    if (principal === undefined || envUtilities === undefined) {
      throw new Error(
        'pipeline order violated: pipelineAuthorize requires pipelineEnv and pipelineSession first.'
      );
    }

    const { routeClass, matchedUndeclaredHandler } = resolveDeclaredClass(c);
    if (routeClass === undefined && !matchedUndeclaredHandler) {
      return next();
    }

    const decision = authorizeAccess(routeClass, principal, envUtilities);
    if (!decision.allowed) {
      // The wire mapping is this emission boundary: the decision keeps the
      // lowercase DomainError taxonomy; clients only ever see ERROR_CODES.*.
      return c.json(createErrorResponse(WIRE_CODE_BY_DOMAIN_CODE[decision.code]), decision.status);
    }
    return next();
  });
}
