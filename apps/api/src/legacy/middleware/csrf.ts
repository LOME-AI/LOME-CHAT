import { ERROR_CODE_CSRF_REJECTED } from '@hushbox/shared';
import { createErrorResponse } from '../lib/error-response.js';
import type { MiddlewareHandler } from 'hono';

interface CsrfEnv {
  Bindings: {
    FRONTEND_URL?: string;
    FRONTEND_PREVIEW_URL?: string;
  };
}

const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);

/** Capacitor WebView origins (iOS + Android) — always trusted */
const CAPACITOR_ORIGINS = new Set(['capacitor://localhost', 'http://localhost']);

/**
 * CSRF protection middleware using Origin header validation.
 *
 * For state-changing requests (POST, PUT, DELETE, PATCH):
 * - Requests without Origin header are allowed (same-origin requests)
 * - Requests with Origin header must match FRONTEND_URL or a Capacitor origin
 *
 * GET/HEAD/OPTIONS requests are not affected.
 */
const csrfHandler: MiddlewareHandler<CsrfEnv> = async (c, next) => {
  if (!STATE_CHANGING_METHODS.has(c.req.method)) {
    return next();
  }

  const origin = c.req.header('Origin');

  // No Origin header typically means same-origin request
  // (browsers add Origin for cross-origin requests)
  if (!origin) {
    return next();
  }

  // Capacitor native WebView origins are always allowed
  if (CAPACITOR_ORIGINS.has(origin)) {
    return next();
  }

  const allowedUrls = [c.env.FRONTEND_URL, c.env.FRONTEND_PREVIEW_URL].filter(
    (url): url is string => url != null
  );
  if (allowedUrls.length === 0) {
    return c.json(createErrorResponse(ERROR_CODE_CSRF_REJECTED), 403);
  }

  try {
    const parsedOrigin = new URL(origin).origin;
    const allowed = allowedUrls.some((url) => new URL(url).origin === parsedOrigin);

    if (!allowed) {
      return c.json(createErrorResponse(ERROR_CODE_CSRF_REJECTED), 403);
    }
  } catch {
    return c.json(createErrorResponse(ERROR_CODE_CSRF_REJECTED), 403);
  }

  return next();
};

export function csrfProtection(): MiddlewareHandler<CsrfEnv> {
  return csrfHandler;
}
