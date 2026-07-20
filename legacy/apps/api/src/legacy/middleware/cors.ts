import { cors as honoCors } from 'hono/cors';
import type { MiddlewareHandler } from 'hono';

interface CorsBindings {
  FRONTEND_URL?: string;
  FRONTEND_PREVIEW_URL?: string;
}

/** Capacitor WebView origins (iOS + Android) */
const CAPACITOR_ORIGINS = ['capacitor://localhost', 'http://localhost'];

/**
 * URL prefix reserved for unauthenticated, CDN-cacheable read endpoints
 * (e.g. /api/public/roadmap). Routes under this prefix get wildcard CORS
 * without credentials — any origin may fetch, no cookies are ever sent,
 * so cross-origin authentication risk is structurally zero. New public
 * read endpoints should be mounted under this prefix instead of adding
 * one-off CORS carve-outs.
 */
const PUBLIC_NAMESPACE_PREFIX = '/api/public/';

export function cors(): MiddlewareHandler<{ Bindings: CorsBindings }> {
  // eslint-disable-next-line unicorn/consistent-function-scoping -- middleware factory pattern
  return async (c, next) => {
    if (c.req.path.startsWith(PUBLIC_NAMESPACE_PREFIX)) {
      return honoCors({ origin: '*' })(c, next);
    }

    const origins = [
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- c.env may be undefined in tests
      ...(c.env?.FRONTEND_URL ? [c.env.FRONTEND_URL] : []),
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- c.env may be undefined in tests
      ...(c.env?.FRONTEND_PREVIEW_URL ? [c.env.FRONTEND_PREVIEW_URL] : []),
      ...CAPACITOR_ORIGINS,
    ];

    const corsMiddleware = honoCors({
      origin: origins,
      credentials: true,
    });

    return corsMiddleware(c, next);
  };
}
