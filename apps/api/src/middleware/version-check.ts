import { ERROR_CODES, VALID_PLATFORMS } from '@hushbox/shared';
import { createErrorResponse } from '../lib/errors/index.js';
import { getVersionOverride } from './version-override.js';
import type { Platform } from '@hushbox/shared';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv, Bindings } from '../lib/context/index.js';

/** APP_VERSION is a registry entry (dev value 'dev-local'); typed here because the bindings gate does not narrow it. */
interface VersionCheckBindings extends Bindings {
  APP_VERSION?: string;
}

/** Server versions that skip the check (dev / test environments). */
const SKIP_VERSIONS = new Set(['dev-local', 'test']);

/**
 * Route prefixes that bypass version checking — the new-tree mounts of the
 * legacy exemptions (/api/health, /api/webhooks, /api/auth/token-login,
 * /api/updates). '/updates' is reserved ahead of the platform-routes task
 * that mounts the OTA download surface.
 */
export const VERSION_CHECK_EXEMPT_PREFIXES = [
  '/health',
  '/billing/webhooks',
  '/auth/token-login',
  '/updates',
] as const;

function isPlatform(value: string): value is Platform {
  return (VALID_PLATFORMS as readonly string[]).includes(value);
}

/** The caller's platform from the X-HushBox-Platform header; unknown or absent means web. */
function requestPlatform(header: string | undefined): Platform {
  return header !== undefined && isPlatform(header) ? header : 'web';
}

/**
 * Rejects requests from clients running a stale version. Compares
 * `X-App-Version` against the APP_VERSION registry value; a missing header
 * passes (browsers cannot set custom headers on WS upgrades — this rule is
 * what keeps the websocket routes working). Mismatch answers 426 with the
 * current version; mobile platforms also get the OTA download URL.
 */
export function versionCheck(): MiddlewareHandler<AppEnv> {
  // eslint-disable-next-line unicorn/consistent-function-scoping -- middleware factory pattern
  return async (c, next) => {
    const clientVersion = c.req.header('X-App-Version');
    if (clientVersion === undefined) return next();

    const env: VersionCheckBindings = c.env;
    // Dev-only override first (set via POST /dev/set-version, 404 in prod):
    // it lets E2E drive a mismatch even though dev's APP_VERSION is a
    // SKIP_VERSIONS value.
    const serverVersion = getVersionOverride() ?? env.APP_VERSION;
    if (serverVersion === undefined || serverVersion === '') {
      throw new Error('APP_VERSION is required when a client sends X-App-Version');
    }
    if (SKIP_VERSIONS.has(serverVersion)) return next();

    const path = c.req.path;
    if (VERSION_CHECK_EXEMPT_PREFIXES.some((prefix) => path.startsWith(prefix))) return next();

    if (clientVersion === serverVersion) return next();

    const platform = requestPlatform(c.req.header('X-HushBox-Platform'));
    const errorResponse = createErrorResponse(ERROR_CODES.VERSION_MISMATCH);
    if (platform === 'web') {
      return c.json({ ...errorResponse, currentVersion: serverVersion }, 426);
    }
    return c.json(
      {
        ...errorResponse,
        currentVersion: serverVersion,
        updateUrl: `/updates/download/${platform}/${serverVersion}`,
      },
      426
    );
  };
}
