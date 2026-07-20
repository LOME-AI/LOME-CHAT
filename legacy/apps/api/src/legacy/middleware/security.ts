import type { MiddlewareHandler } from 'hono';

/**
 * Security headers middleware that adds important HTTP security headers.
 *
 * Headers set:
 * - Content-Security-Policy: Restricts resources the browser can load
 * - X-Content-Type-Options: Prevents MIME type sniffing
 * - X-Frame-Options: Prevents clickjacking
 * - Referrer-Policy: Controls information sent in Referer header
 *
 * Note: CSP includes 'unsafe-inline' for style-src to support Tailwind CSS.
 * This is a trade-off for developer experience vs strict security.
 */
export function securityHeaders(): MiddlewareHandler {
  const cspDirectives = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'", // Required for Tailwind CSS
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ];

  const cspHeader = cspDirectives.join('; ');

  return async (c, next) => {
    await next();

    c.header('Content-Security-Policy', cspHeader);
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'no-referrer');
  };
}
