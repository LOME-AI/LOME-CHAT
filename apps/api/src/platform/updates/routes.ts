import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { ERROR_CODES, MOBILE_PLATFORMS } from '@hushbox/shared';
import { defineSliceManifest, routeClass } from '../../middleware/pipeline-manifest.js';
import { createErrorResponse } from '../../lib/errors/index.js';
import { getVersionOverride } from '../../middleware/version-override.js';
import type { Context, Env } from 'hono';
import type { AppEnv, Bindings } from '../../lib/context/index.js';

/**
 * The minimal structural slice of the `APP_BUILDS` R2 bucket binding the
 * download route consumes. Structural (not the global `R2Bucket` type) so
 * integration tests can back it with MinIO through the same shape.
 */
export interface AppBuildsBucket {
  get(key: string): Promise<{ readonly body: ReadableStream | null; readonly size: number } | null>;
}

/** APP_VERSION + APP_BUILDS are per-consumer bindings (not pipeline-gated). */
interface UpdatesBindings extends Bindings {
  APP_VERSION?: string;
  APP_BUILDS?: AppBuildsBucket;
}

const downloadParamsSchema = z.object({
  platform: z.enum(MOBILE_PLATFORMS as unknown as [string, ...string[]]),
  version: z.string().min(1),
});

/** Malformed input answers the uniform `{code}` body (hook typed with hono's base Env). */
function rejectInvalid(
  result: { readonly success: boolean },
  c: Context<Env, string>
): Response | undefined {
  return result.success ? undefined : c.json(createErrorResponse(ERROR_CODES.VALIDATION), 400);
}

/**
 * OTA update surface (both routes public; the version-check middleware
 * exempts the `/updates` prefix so a stale client can always reach them):
 *
 * - `GET /updates/current` — the served app version; the dev-only override
 *   (POST /dev/set-version) wins so E2E can drive a mismatch.
 * - `GET /updates/download/:platform/:version` — streams the mobile bundle
 *   from the APP_BUILDS R2 bucket with immutable cache headers; a missing
 *   binding or object answers 404 `BUILD_NOT_FOUND`.
 */
export function createUpdatesManifest() {
  return defineSliceManifest({
    basePath: '/updates',
    routes: new Hono<AppEnv>()
      .get('/current', routeClass('public'), (c) => {
        const env: UpdatesBindings = c.env;
        const version = getVersionOverride() ?? env.APP_VERSION;
        if (version === undefined || version === '') {
          throw new Error('APP_VERSION is required to serve /updates/current');
        }
        return c.json({ version }, 200);
      })
      .get(
        '/download/:platform/:version',
        routeClass('public'),
        zValidator('param', downloadParamsSchema, rejectInvalid),
        async (c) => {
          const { platform, version } = c.req.valid('param');
          const env: UpdatesBindings = c.env;
          const bucket = env.APP_BUILDS;
          if (bucket === undefined) {
            return c.json(createErrorResponse(ERROR_CODES.BUILD_NOT_FOUND), 404);
          }
          const object = await bucket.get(`builds/${platform}/${version}.zip`);
          if (object === null) {
            return c.json(createErrorResponse(ERROR_CODES.BUILD_NOT_FOUND), 404);
          }
          return new Response(object.body, {
            status: 200,
            headers: {
              'content-type': 'application/zip',
              'content-length': String(object.size),
              'cache-control': 'public, max-age=86400, immutable',
            },
          });
        }
      ),
  });
}
