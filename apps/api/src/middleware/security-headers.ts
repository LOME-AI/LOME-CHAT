import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../lib/context/index.js';

/**
 * The CSP mirrors the legacy backend exactly ('unsafe-inline' for style-src
 * supports Tailwind).
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
 * One year + includeSubDomains. Deliberately NO `preload`: the preload list is
 * a semi-irreversible commitment (slow removal) and is a separate founder
 * decision. Lowering max-age keeps this reversible. Every HushBox surface is
 * served over HTTPS via Cloudflare, so `includeSubDomains` is safe.
 */
const HSTS_HEADER = 'max-age=31536000; includeSubDomains';

/**
 * Default-deny the powerful browser features the app never uses. Features the
 * app does use are intentionally left unlisted so they keep their default
 * allowlist (`self`): clipboard-write (copy buttons) and fullscreen (video
 * expand). Helcim runs via HelcimPay.js, not the W3C Payment Request API, so
 * `payment=()` is safe.
 */
const PERMISSIONS_POLICY_HEADER = [
  'camera=()',
  'microphone=()',
  'geolocation=()',
  'payment=()',
  'usb=()',
  'magnetometer=()',
  'gyroscope=()',
  'accelerometer=()',
].join(', ');

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
      c.header('Strict-Transport-Security', HSTS_HEADER);
      c.header('Permissions-Policy', PERMISSIONS_POLICY_HEADER);
    }
  };
}
