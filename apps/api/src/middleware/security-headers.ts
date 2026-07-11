import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../lib/context/index.js';

/**
 * The CSP mirrors the legacy backend exactly ('unsafe-inline' for style-src
 * supports Tailwind). No HSTS and no Permissions-Policy — deliberate legacy
 * parity, not an omission.
 */
const CSP_HEADER = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

/**
 * Security headers on EVERY response class. The `finally` is load-bearing:
 * a handler that throws never produces `c.res`, but headers set on the
 * context before the error reaches `onError` are applied when `onError`
 * builds its response — so 500s carry the headers too, not just successes
 * and 404s.
 */
export function securityHeaders(): MiddlewareHandler<AppEnv> {
  // eslint-disable-next-line unicorn/consistent-function-scoping -- middleware factory pattern
  return async (c, next) => {
    try {
      await next();
    } finally {
      c.header('Content-Security-Policy', CSP_HEADER);
      c.header('X-Content-Type-Options', 'nosniff');
      c.header('X-Frame-Options', 'DENY');
      c.header('Referrer-Policy', 'no-referrer');
    }
  };
}
