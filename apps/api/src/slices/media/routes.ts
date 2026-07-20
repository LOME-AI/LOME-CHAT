import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { ERROR_CODES } from '@hushbox/shared';
import { defineSliceManifest, routeClass } from '../../middleware/pipeline-manifest.js';
import { rateLimitByCaller, rateLimitByIp } from '../../middleware/rate-limit.js';
import {
  MEDIA_RATE_LIMITS,
  LINK_CREDENTIAL_HEADER,
  contentItemParameterSchema,
  createErrorResponse,
  domainWireCode,
  mintDownloadUrl,
  reserveShareRemint,
  resolveMediaCaller,
  sharedPresignParameterSchema,
} from './domain/index.js';
import type { Context, Env } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AppEnv } from '../../middleware/pipeline-manifest.js';
import type {
  DomainError,
  DomainErrorCode,
  LinkResolutionPort,
  MintDownloadUrlDeps,
  PresignReaders,
  Storage,
} from './domain/index.js';

/** The pipeline's per-request database handle, named without importing the infra module. */
type RequestDb = AppEnv['Variables']['db'];

export interface MediaRouteDeps {
  /** Presign readers over the owning slices' rows, bound to the request db. */
  readonly readers: (db: RequestDb) => PresignReaders;
  /**
   * The Storage port; the composition root binds R2 config from env. The
   * per-request db is threaded through because the R2 factory records CI
   * service-evidence through it — a bound-at-request concern, not a static one.
   */
  readonly storage: (env: AppEnv['Bindings'], db: RequestDb) => Storage;
  /** Shared-link credential resolution (the identity slice's port). */
  readonly linkResolution: (db: RequestDb) => LinkResolutionPort;
}

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

// Return type is deliberately inferred (the typed `TypedResponse` over the
// non-200 error statuses), NOT annotated `: Response` as the sibling slices do.
// These handlers are multi-return (auth/gate checks return early, then a
// success `c.json(grant, 200)` tail): a bare `Response` member in that return
// union is simplified by TS to swallow the sibling `TypedResponse<…, 200>`,
// collapsing the 200 body to `{}` in `AppType` and blinding `hc<AppType>`.
// Keeping the error responder typed leaves every arm distinct, so the grant
// body flows to the typed client. The single-return `.match` handlers in other
// slices don't hit this, which is why they can annotate `: Response`.
function respondDomainError(c: Context<AppEnv>, error: DomainError) {
  return c.json(createErrorResponse(domainWireCode(error)), STATUS_BY_DOMAIN_CODE[error.code]);
}

/**
 * zValidator hook: malformed input answers the uniform `{code}` body. Typed
 * with hono's base `Env` because the hook's `E` is not inferred from the
 * route chain — `AppEnv` here would fail contravariance.
 */
function rejectInvalid(
  result: { readonly success: boolean },
  c: Context<Env, string>
): Response | undefined {
  return result.success ? undefined : c.json(createErrorResponse(ERROR_CODES.VALIDATION), 400);
}

function mintDeps(deps: MediaRouteDeps, c: Context<AppEnv>): MintDownloadUrlDeps {
  return {
    readers: deps.readers(c.var.db),
    storage: deps.storage(c.env, c.var.db),
    now: () => new Date(),
  };
}

// No return annotation on purpose: the chained route schema must flow through
// `defineSliceManifest`'s generic so `AppType` (and the typed client) carry
// this slice's routes — an explicit `Hono<AppEnv>` would erase it to
// `BlankSchema`.
export function createMediaManifest(deps: MediaRouteDeps) {
  return defineSliceManifest({
    basePath: '/media',
    routes: new Hono<AppEnv>()
      // Member path. `public` route class by necessity, not laxity: the HTTP
      // matrix admits no link-guest principal, so the handler resolves the
      // caller itself (full session OR link credential) and everyone else is
      // answered 401 here. Per-caller mint throttling is the
      // `mediaDownloadUserRateLimit` registry entry, enforced by the mounted
      // edge limiter below.
      .get(
        '/:contentItemId/download-url',
        routeClass('public'),
        zValidator('param', contentItemParameterSchema, rejectInvalid),
        rateLimitByCaller(MEDIA_RATE_LIMITS.mediaDownloadUserRateLimit, {
          credentialHeader: LINK_CREDENTIAL_HEADER,
        }),
        async (c) => {
          const { contentItemId } = c.req.valid('param');
          const caller = await resolveMediaCaller({
            principal: c.var.principal,
            linkCredential: c.req.header(LINK_CREDENTIAL_HEADER),
            linkResolution: deps.linkResolution(c.var.db),
          });
          if (caller.isErr()) return respondDomainError(c, caller.error);
          if (caller.value === null) {
            return c.json(createErrorResponse(ERROR_CODES.UNAUTHORIZED), 401);
          }
          const minted = await mintDownloadUrl(mintDeps(deps, c), caller.value, contentItemId);
          return minted.match(
            (grant) => c.json(grant, 200),
            (error) => respondDomainError(c, error)
          );
        }
      )
      // Share carve-out: unauthenticated by design (a valid shareId is the
      // capability), scoped to exactly that shared message's content items by
      // the authorization. Per-IP throttling is a registry entry for the edge
      // enforcer (`sharePresignIpRateLimit`); the per-shareId re-mint cap is
      // enforced HERE, before any lookup, so a leaked shareId cannot probe or
      // re-arm URLs without bound.
      .get(
        '/shared/:shareId/:contentItemId/download-url',
        routeClass('public'),
        zValidator('param', sharedPresignParameterSchema, rejectInvalid),
        // Per-IP cap (edge enforcer, `sharePresignIpRateLimit`) alongside the
        // in-handler per-shareId re-mint cap below — the IP cap bounds one
        // caller across shares, the shareId cap bounds one leaked share
        // across callers.
        rateLimitByIp(MEDIA_RATE_LIMITS.sharePresignIpRateLimit),
        async (c) => {
          const { shareId, contentItemId } = c.req.valid('param');
          const gate = await reserveShareRemint(c.var.redis, shareId);
          /* v8 ignore next -- the same-redis rateLimitByIp above fails closed (503) on any Redis outage before this runs, so reserveShareRemint only executes when Redis is healthy; a mid-handler Redis fault is not deterministically reproducible */
          if (gate.isErr()) return respondDomainError(c, gate.error);
          if (!gate.value.allowed) {
            return c.json(
              createErrorResponse(ERROR_CODES.RATE_LIMITED, {
                retryAfterSeconds: gate.value.retryAfterSeconds,
              }),
              429
            );
          }
          const minted = await mintDownloadUrl(
            mintDeps(deps, c),
            { kind: 'share', shareId },
            contentItemId
          );
          return minted.match(
            (grant) => c.json(grant, 200),
            (error) => respondDomainError(c, error)
          );
        }
      ),
  });
}
