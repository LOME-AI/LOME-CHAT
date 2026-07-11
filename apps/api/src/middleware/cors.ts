import { cors as honoCors } from 'hono/cors';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv, Bindings } from '../lib/context/index.js';

/**
 * The frontend-origin env vars the CORS allowlist reads. Registry entries
 * (`FRONTEND_URL` required per mode, `FRONTEND_PREVIEW_URL` optional) — typed
 * here as an extension because `assertRequiredBindings` does not gate them:
 * CORS runs before the bindings stage and tolerates absence (legacy parity —
 * the allowlist simply shrinks to the Capacitor origins).
 */
interface CorsBindings extends Bindings {
  FRONTEND_URL?: string;
  FRONTEND_PREVIEW_URL?: string;
}

/** Capacitor WebView origins (iOS + Android) — always allowed. */
const CAPACITOR_ORIGINS = ['capacitor://localhost', 'http://localhost'] as const;

/**
 * Credentialed allowlist CORS for every route. The legacy '/api/public/'
 * wildcard prefix (origin '*', no credentials) has no new-tree equivalent —
 * no public namespace prefix exists — so the wildcard rule deliberately
 * applies to nothing; if a CDN-cacheable public namespace ever lands, the
 * carve-out returns with it.
 */
export function cors(): MiddlewareHandler<AppEnv> {
  // eslint-disable-next-line unicorn/consistent-function-scoping -- middleware factory pattern
  return async (c, next) => {
    const env: CorsBindings = c.env;
    const origins = [
      ...(env.FRONTEND_URL === undefined ? [] : [env.FRONTEND_URL]),
      ...(env.FRONTEND_PREVIEW_URL === undefined ? [] : [env.FRONTEND_PREVIEW_URL]),
      ...CAPACITOR_ORIGINS,
    ];
    return honoCors({ origin: origins, credentials: true })(c, next);
  };
}
