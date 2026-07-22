import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { ERROR_CODES } from '@hushbox/shared';

import { defineSliceManifest, routeClass } from '../../middleware/pipeline-manifest.js';
import {
  bannerHashQuerySchema,
  callerUserId,
  createErrorResponse,
  domainWireCode,
  getActiveBanner,
  getBannerDismissal,
  idempotencyExempt,
  idempotent,
  putBannerDismissalBodySchema,
  runMutation,
  saveBannerDismissal,
} from './domain/index.js';

import type { Context, Env } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AppEnv } from '../../middleware/pipeline-manifest.js';
import type { AnnouncementsStoresFactory, DomainError, DomainErrorCode } from './domain/index.js';

export interface AnnouncementsRouteDeps {
  /** Constructed per request from the pipeline's `c.var.db`. */
  readonly stores: AnnouncementsStoresFactory;
}

/** Edge cache window for the user-agnostic banner payload. */
const BANNER_CACHE_S_MAXAGE = 60;

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
  return c.json(createErrorResponse(domainWireCode(error)), STATUS_BY_DOMAIN_CODE[error.code]);
}

function rejectInvalid(
  result: { readonly success: boolean },
  c: Context<Env, string>
): Response | undefined {
  return result.success ? undefined : c.json(createErrorResponse(ERROR_CODES.VALIDATION), 400);
}

/**
 * The announcements slice's HTTP surface. `GET /banner` is public and
 * edge-cacheable (user-agnostic). The per-user dismissal routes are
 * `session`-class; the write is `naturally-idempotent` (a repeat converges on
 * the same one-row-per-user state through `idempotent.byUpsert`).
 *
 * The return type is deliberately inferred: annotating it with a bare
 * `Hono<AppEnv>` widens the routes to `BlankSchema` and erases the route
 * schema from `AppType` (the typed client goes blind to this slice).
 */
export function createAnnouncementsManifest(deps: AnnouncementsRouteDeps) {
  return defineSliceManifest({
    basePath: '/announcements',
    routes: new Hono<AppEnv>()
      .get('/banner', routeClass('public'), async (c) => {
        const result = await getActiveBanner(deps.stores(c.var.db).config);
        return result.match(
          ({ response, droppedCount }) => {
            if (droppedCount > 0) {
              c.var.logger.warn('banner.config.salvaged', { droppedCount });
            }
            c.header('Cache-Control', `public, s-maxage=${String(BANNER_CACHE_S_MAXAGE)}`);
            return c.json(response, 200);
          },
          (error) => respondDomainError(c, error)
        );
      })
      .get(
        '/banner/dismissal',
        routeClass('session'),
        zValidator('query', bannerHashQuerySchema, rejectInvalid),
        async (c) => {
          const { hash } = c.req.valid('query');
          const result = await getBannerDismissal(
            deps.stores(c.var.db).dismissals,
            callerUserId(c.var.principal),
            hash
          );
          return result.match(
            (state) => c.json(state, 200),
            (error) => respondDomainError(c, error)
          );
        }
      )
      .put(
        '/banner/dismissal',
        routeClass('session'),
        idempotencyExempt('naturally-idempotent'),
        zValidator('json', putBannerDismissalBodySchema, rejectInvalid),
        async (c) => {
          const { hash } = c.req.valid('json');
          const result = await runMutation(() =>
            idempotent.byUpsert(() =>
              saveBannerDismissal(
                deps.stores(c.var.db).dismissals,
                callerUserId(c.var.principal),
                hash
              )
            )
          );
          return result.match(
            (state) => c.json(state, 200),
            (error) => respondDomainError(c, error)
          );
        }
      ),
  });
}
