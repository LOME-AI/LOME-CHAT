import { match } from 'ts-pattern';
import type { Principal } from './principal.js';

/**
 * The closed set of route classes. EVERY route mounted under the app must
 * declare exactly one; an undeclared route is denied by the pipeline
 * (default-deny). Derived from the legacy app's auth surface:
 * - `public` — unauthenticated reads/entry points (health, trial, shares,
 *   webhooks, public roadmap);
 * - `session` — a full session required (the legacy `sessionMiddleware`
 *   surface: conversations, chat, billing-adjacent CRUD, …);
 * - `pending-2fa` — auth-flow routes that MUST stay reachable while a session
 *   is mid-2FA (login/2fa/verify and the legacy `/api/auth/*` mounts that
 *   deliberately skipped `sessionMiddleware`);
 * - `billing-token` — the mobile → web billing handoff surface; admits
 *   `billingOnly` sessions in addition to full ones;
 * - `dev-only` — hidden (404) in production, open otherwise.
 */
export const ROUTE_CLASSES = [
  'public',
  'session',
  'pending-2fa',
  'billing-token',
  'dev-only',
] as const;

export type RouteClass = (typeof ROUTE_CLASSES)[number];

export type AccessDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly status: 401 | 403 | 404;
      readonly code: 'unauthorized' | 'forbidden' | 'not_found';
    };

const ALLOWED: AccessDecision = { allowed: true };
const FORBIDDEN: AccessDecision = { allowed: false, status: 403, code: 'forbidden' };
const NOT_FOUND: AccessDecision = { allowed: false, status: 404, code: 'not_found' };

/** A caller with no session is unauthenticated; a half-authenticated one is forbidden. */
function denyByPrincipal(principal: Principal): AccessDecision {
  return principal.kind === 'none'
    ? { allowed: false, status: 401, code: 'unauthorized' }
    : FORBIDDEN;
}

/**
 * The authorization matrix — the single decision point for route-class
 * enforcement. `undefined` means the matched route declared no class: that is
 * default-deny (forbidden for everyone, including full sessions), not merely
 * unauthenticated.
 *
 * A `pending-2fa` principal passes only `public`, `pending-2fa`, and non-prod
 * `dev-only` — i.e. exactly the anonymous surface plus its own route class —
 * so a password-only session can never act as an authenticated one.
 */
export function authorizeAccess(
  routeClass: RouteClass | undefined,
  principal: Principal,
  env: { readonly isProduction: boolean }
): AccessDecision {
  if (routeClass === undefined) return FORBIDDEN;
  // The HTTP matrix admits NO link-guest: the pipeline never derives one from
  // a cookie, so a link-guest principal reaching this gate is out-of-band by
  // construction and fails closed — even on `public`, which costs a guest
  // nothing (anonymous HTTP access needs no principal). Link-guest
  // authorization happens at the realtime/media seams by typed match on the
  // principal, never through route classes.
  if (principal.kind === 'link-guest') return FORBIDDEN;
  return match(routeClass)
    .with('public', () => ALLOWED)
    .with('pending-2fa', () => ALLOWED)
    .with('dev-only', () => (env.isProduction ? NOT_FOUND : ALLOWED))
    .with('session', () => (principal.kind === 'full' ? ALLOWED : denyByPrincipal(principal)))
    .with('billing-token', () =>
      principal.kind === 'full' || principal.kind === 'billing-only'
        ? ALLOWED
        : denyByPrincipal(principal)
    )
    .exhaustive();
}
