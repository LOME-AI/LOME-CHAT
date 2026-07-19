import { ERROR_CODES } from '@hushbox/shared';
import { createErrorResponse } from '../lib/errors/index.js';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv, Bindings } from '../lib/context/index.js';

/**
 * The origin env vars the Origin check compares against (registry entries).
 * ADMIN_URL is load-bearing, not redundancy: Cloudflare Access authenticates
 * via its edge cookie and injects the JWT assertion header itself, so a
 * cross-site POST to admin.hushbox.ai can arrive authenticated — Origin
 * checking is the admin plane's real CSRF protection. Browsers send Origin on
 * ALL POSTs (same-origin included), so the admin SPA's own origin must be
 * admitted or every production admin mutation 403s.
 * MARKETING_URL is admitted for the same reason: the marketing site makes
 * cross-origin mutating POSTs to the newsletter public routes, and browsers
 * send Origin on those POSTs, so its origin must be allowed or they 403 (a dev
 * concern only — in production it collapses onto FRONTEND_URL == hushbox.ai).
 */
interface CsrfBindings extends Bindings {
  FRONTEND_URL?: string;
  FRONTEND_PREVIEW_URL?: string;
  ADMIN_URL?: string;
  MARKETING_URL?: string;
}

const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);

/** Capacitor WebView origins (iOS + Android) — always trusted. */
const CAPACITOR_ORIGINS = new Set(['capacitor://localhost', 'http://localhost']);

/**
 * Mutating surfaces exempt from Origin validation, by path prefix:
 * - '/billing/webhooks/' — provider-signed calls (signature IS the auth;
 *   Helcim sends no browser Origin);
 * - '/auth/token-login' — the one-time token is the credential.
 * GET surfaces (WS upgrades, health, the public share read) need no entry:
 * CSRF guards state-changing methods only, so they are structurally exempt.
 */
export const CSRF_EXEMPT_PATH_PREFIXES = ['/billing/webhooks/', '/auth/token-login'] as const;

/**
 * The single allowed-origin source for the whole Worker: `true` when `origin`
 * is a Capacitor WebView or matches a configured app URL (frontend, preview,
 * admin, marketing). NO fail-open — missing configuration admits nothing, and
 * an unparseable Origin is rejected. Shared by `csrfProtection` (mutating HTTP)
 * and the WebSocket upgrade's Origin gate: the WS handshake is a GET,
 * structurally exempt from CSRF, so it calls this directly to close cross-site
 * WebSocket hijacking against the same allowlist.
 */
export function isAllowedOrigin(origin: string, env: CsrfBindings): boolean {
  if (CAPACITOR_ORIGINS.has(origin)) {
    return true;
  }
  const allowedUrls = [
    env.FRONTEND_URL,
    env.FRONTEND_PREVIEW_URL,
    env.ADMIN_URL,
    env.MARKETING_URL,
  ].filter((url): url is string => url !== undefined);
  if (allowedUrls.length === 0) {
    return false;
  }
  try {
    const parsedOrigin = new URL(origin).origin;
    return allowedUrls.some((url) => new URL(url).origin === parsedOrigin);
  } catch {
    return false;
  }
}

/**
 * CSRF protection via Origin validation — no token, and NO fail-open:
 * a state-changing cross-origin request is rejected unless its Origin is a
 * Capacitor WebView or matches a configured frontend URL; missing
 * configuration rejects rather than admits. A request without an Origin
 * header passes (browsers attach Origin to cross-origin mutations).
 */
export function csrfProtection(): MiddlewareHandler<AppEnv> {
  // eslint-disable-next-line unicorn/consistent-function-scoping -- middleware factory pattern
  return async (c, next) => {
    if (!STATE_CHANGING_METHODS.has(c.req.method)) {
      return next();
    }
    const path = c.req.path;
    if (CSRF_EXEMPT_PATH_PREFIXES.some((prefix) => path.startsWith(prefix))) {
      return next();
    }

    const origin = c.req.header('Origin');
    // No Origin header typically means a same-origin request.
    if (origin === undefined) {
      return next();
    }
    if (!isAllowedOrigin(origin, c.env)) {
      return c.json(createErrorResponse(ERROR_CODES.CSRF_REJECTED), 403);
    }

    return next();
  };
}
