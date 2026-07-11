import { useEffect, useRef } from 'react';
import { App } from '@capacitor/app';
import { isNative } from '../platform.js';

/** Safe default when an incoming deep link can't be trusted. */
const FALLBACK_PATH = '/';

/**
 * Internal routes reachable via deep link / push, as exact paths or prefixes.
 *
 * Token-sensitive auth routes (`/verify`, `/billing-portal`, `/login`,
 * `/signup`) and dev-only routes are deliberately excluded: a custom-scheme
 * deep link must not be able to drive navigation to them with attacker-supplied
 * query tokens.
 */
const ALLOWED_PREFIXES = [
  '/chat',
  '/share/m',
  '/share/c',
  '/settings',
  '/usage',
  '/billing',
  '/accessibility',
] as const;

function isAllowedPath(pathname: string): boolean {
  if (pathname === '/') return true;
  return ALLOWED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
}

/**
 * Parses an untrusted deep-link URL into a safe in-app path.
 *
 * Returns the validated `pathname + search`, or {@link FALLBACK_PATH} when the
 * URL is malformed, protocol-relative (`//host`), or targets a route outside
 * the allowlist.
 */
function toSafePath(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return FALLBACK_PATH;
  }

  if (!isAllowedPath(parsed.pathname)) return FALLBACK_PATH;

  return parsed.pathname + parsed.search;
}

/**
 * Listens for universal/app links opened from outside the app.
 *
 * Validates the untrusted URL against an allowlist of deep-linkable routes
 * before delegating to the callback, which should navigate via TanStack Router.
 * Malformed or non-allowlisted links fall back to a safe default route.
 * No-op on web.
 *
 * @param onDeepLink - Receives a validated URL path (e.g. `/chat/123`)
 */
export function useDeepLinks(onDeepLink?: (path: string) => void): void {
  const callbackRef = useRef(onDeepLink);
  callbackRef.current = onDeepLink;

  useEffect(() => {
    if (!isNative()) return;

    const listener = App.addListener('appUrlOpen', ({ url }) => {
      callbackRef.current?.(toSafePath(url));
    });

    return () => {
      void (async () => {
        const handle = await listener;
        await handle.remove();
      })();
    };
  }, []);
}
