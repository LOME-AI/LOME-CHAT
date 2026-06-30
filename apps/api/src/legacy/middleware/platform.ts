import { VALID_PLATFORMS, type Platform } from '@hushbox/shared';
import type { MiddlewareHandler } from 'hono';

const validPlatformSet = new Set<string>(VALID_PLATFORMS);

/**
 * Reads the X-HushBox-Platform header and sets `c.var.platform`.
 *
 * The header is client-provided and informational. Never trust it
 * for security-critical decisions — use it for feature toggling
 * (e.g. payment disabled on App Store builds) and analytics only.
 */
export function platformMiddleware(): MiddlewareHandler<{
  Variables: { platform: Platform };
}> {
  return async (c, next) => {
    const header = c.req.header('X-HushBox-Platform') ?? '';
    const platform: Platform = validPlatformSet.has(header) ? (header as Platform) : 'web';
    c.set('platform', platform);
    return next();
  };
}
