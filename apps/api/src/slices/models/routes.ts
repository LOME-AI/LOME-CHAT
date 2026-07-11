import { Hono } from 'hono';
import { DOMAIN_ERROR_CODE_TO_WIRE_CODE } from '@hushbox/shared';
import { defineSliceManifest, routeClass } from '../../middleware/pipeline-manifest.js';
import { createErrorResponse, listModels } from './domain/index.js';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AppEnv } from '../../middleware/pipeline-manifest.js';
import type { DomainError, DomainErrorCode } from './domain/index.js';

const STATUS_BY_DOMAIN_CODE = {
  validation: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  timeout: 408,
  unavailable: 503,
} as const satisfies Record<DomainErrorCode, ContentfulStatusCode>;

function respondDomainError(c: Context<AppEnv>, error: DomainError): Response {
  return c.json(
    createErrorResponse(DOMAIN_ERROR_CODE_TO_WIRE_CODE[error.code]),
    STATUS_BY_DOMAIN_CODE[error.code]
  );
}

/**
 * The models slice's HTTP surface: the public catalog list. `public`-class by
 * design — the marketing site fetches it unauthenticated at build time, and
 * the picker loads it before login. Read-only, so no idempotency machinery.
 *
 * The return type is deliberately inferred: annotating it with a bare
 * `Hono<AppEnv>` widens the routes to `BlankSchema` and erases the route
 * schema from `AppType` (the typed client goes blind to this slice).
 */
export function createModelsManifest() {
  return defineSliceManifest({
    basePath: '/models',
    routes: new Hono<AppEnv>().get('/', routeClass('public'), async (c) => {
      const result = await listModels({ db: c.var.db, telemetry: c.var.logger }, Date.now());
      return result.match(
        (response) => c.json(response, 200),
        (error) => respondDomainError(c, error)
      );
    }),
  });
}
