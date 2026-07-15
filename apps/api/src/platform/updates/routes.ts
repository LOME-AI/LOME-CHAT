import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { ERROR_CODES, MOBILE_PLATFORMS } from '@hushbox/shared';
import { defineSliceManifest, routeClass } from '../../middleware/pipeline-manifest.js';
import { createErrorResponse } from '../../lib/errors/index.js';
import { getVersionOverride } from '../../middleware/version-override.js';
import type { MobilePlatform } from '@hushbox/shared';
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

/**
 * Per-native-platform sha256 (hex) of the published OTA bundle. OTA bundles are
 * built and stored per platform (`builds/<platform>/<version>.zip`) — each
 * `VITE_PLATFORM` build yields a distinct sha256 — so a single shared checksum
 * would reject every platform but the one it was computed for. The CI OTA
 * publish step computes each bundle's sha256 and `wrangler secret put`s it into
 * the matching binding. Absent/empty ⇒ no integrity check for that platform
 * (parity with a pre-checksum deploy), never a hard failure.
 */
type ChecksumBinding =
  | 'APP_BUNDLE_CHECKSUM_IOS'
  | 'APP_BUNDLE_CHECKSUM_ANDROID'
  | 'APP_BUNDLE_CHECKSUM_ANDROID_DIRECT';

/** APP_VERSION + APP_BUILDS are per-consumer bindings (not pipeline-gated). */
interface UpdatesBindings extends Bindings {
  APP_VERSION?: string;
  APP_BUILDS?: AppBuildsBucket;
  APP_BUNDLE_CHECKSUM_IOS?: string;
  APP_BUNDLE_CHECKSUM_ANDROID?: string;
  APP_BUNDLE_CHECKSUM_ANDROID_DIRECT?: string;
}

/**
 * Maps the client's `X-HushBox-Platform` (mobile platforms only — web never
 * OTA-updates) to its checksum binding. Membership doubles as the platform
 * guard: an unknown/unset/web platform has no entry, so no checksum is served.
 */
const CHECKSUM_BINDING_BY_PLATFORM: Record<MobilePlatform, ChecksumBinding> = {
  ios: 'APP_BUNDLE_CHECKSUM_IOS',
  android: 'APP_BUNDLE_CHECKSUM_ANDROID',
  'android-direct': 'APP_BUNDLE_CHECKSUM_ANDROID_DIRECT',
};

function isMobilePlatform(platform: string): platform is MobilePlatform {
  return platform in CHECKSUM_BINDING_BY_PLATFORM;
}

/**
 * The checksum for the requesting platform, or undefined when the platform is
 * unknown/unset/web or its binding is unset/empty (the client then downloads
 * without an integrity check — unchanged from the pre-checksum behavior).
 */
function resolvePlatformChecksum(
  env: UpdatesBindings,
  platform: string | undefined
): string | undefined {
  if (platform === undefined || !isMobilePlatform(platform)) return undefined;
  const value = env[CHECKSUM_BINDING_BY_PLATFORM[platform]];
  return value === undefined || value === '' ? undefined : value;
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
 * - `GET /updates/current` — the served app version plus the requesting
 *   platform's current bundle sha256 `checksum` (selected by the
 *   `X-HushBox-Platform` header; omitted when deployed without one). The
 *   dev-only override (POST /dev/set-version) wins so E2E can drive a mismatch.
 *   Served `Cache-Control: no-store` — a stale cached version/checksum would
 *   strand clients on an old bundle or fail integrity checks against the live one.
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
        const checksum = resolvePlatformChecksum(env, c.req.header('X-HushBox-Platform'));
        return c.json({ version, checksum }, 200, { 'cache-control': 'no-store' });
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
