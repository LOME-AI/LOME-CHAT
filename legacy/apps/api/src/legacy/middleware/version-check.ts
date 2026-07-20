import { ERROR_CODE_UPGRADE_REQUIRED } from '@hushbox/shared';
import { createErrorResponse } from '../lib/error-response.js';
import { getVersionOverride } from '../lib/version-override.js';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../types.js';

/** Server versions that skip the check (dev / test environments). */
const SKIP_VERSIONS = new Set(['dev-local', 'test']);

/** Route prefixes that bypass version checking. */
const SKIP_PREFIXES = ['/api/health', '/api/webhooks', '/api/auth/token-login', '/api/updates'];

/**
 * Rejects requests from clients running a stale version.
 *
 * Compares `X-App-Version` header against `c.env.APP_VERSION`.
 * When versions differ, returns 426 Upgrade Required.
 * Mobile clients receive an `updateUrl` for OTA download.
 */
export function versionCheck(): MiddlewareHandler<AppEnv> {
  // eslint-disable-next-line unicorn/consistent-function-scoping -- middleware factory pattern
  return async (c, next) => {
    const clientVersion = c.req.header('X-App-Version');
    if (!clientVersion) return next();

    const serverVersion = getVersionOverride() ?? c.env.APP_VERSION;
    if (!serverVersion) {
      throw new Error('APP_VERSION environment variable is required');
    }
    if (SKIP_VERSIONS.has(serverVersion)) return next();

    const path = c.req.path;
    if (SKIP_PREFIXES.some((prefix) => path.startsWith(prefix))) return next();

    if (clientVersion === serverVersion) return next();

    const platform = c.get('platform');
    const errorResponse = createErrorResponse(ERROR_CODE_UPGRADE_REQUIRED);

    if (platform === 'web') {
      return c.json({ ...errorResponse, currentVersion: serverVersion }, 426);
    }

    return c.json(
      {
        ...errorResponse,
        currentVersion: serverVersion,
        updateUrl: `/api/updates/download/${platform}/${serverVersion}`,
      },
      426
    );
  };
}
