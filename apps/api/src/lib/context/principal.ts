import { z } from 'zod';
import type { Redis } from '@upstash/redis';
import type { SessionOptions } from 'iron-session';
import type { DomainError } from '../errors/index.js';
import type { ResultAsync } from '../result/index.js';

/**
 * The session cookie contract inherited from the pre-rewrite app: same name,
 * same iron-session sealing, same options — so existing user cookies keep
 * unsealing across the cutover. Lives here (not in the middleware) because
 * both sides of the contract consume it: the pipeline's session stage reads
 * cookies, the identity slice writes them.
 */
export const SESSION_COOKIE_NAME = 'hushbox_session';
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export function sessionCookieOptions(secret: string, isProduction: boolean): SessionOptions {
  return {
    password: secret,
    cookieName: SESSION_COOKIE_NAME,
    cookieOptions: {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? 'none' : 'lax',
      maxAge: SESSION_MAX_AGE_SECONDS,
    },
  };
}

/**
 * The claims the pipeline reads from the iron-session cookie. The identity
 * slice now owns the write side (`domain/session.ts` seals the cookie on
 * login). This schema stays parse-compatible with the legacy `SessionData`
 * shape (a superset — unknown fields such as email/username are stripped
 * here) so production cookies sealed before the cutover keep unsealing.
 */
const sessionClaimsSchema = z.object({
  userId: z.string().min(1),
  sessionId: z.string().min(1),
  createdAt: z.number(),
  pending2FA: z.boolean(),
  pending2FAExpiresAt: z.number(),
  billingOnly: z.boolean().optional(),
});

export type SessionClaims = z.infer<typeof sessionClaimsSchema>;

/**
 * Validates an unsealed session payload (external input — a cookie the client
 * presented). Anything that fails validation is an unauthenticated request,
 * not a defect: forged or stale cookies are expected input, so this fails
 * closed to `null` rather than throwing.
 */
export function parseSessionClaims(value: unknown): SessionClaims | null {
  const parsed = sessionClaimsSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * The authenticated identity class of the request, consumed by route-class
 * authorization. Exactly one of:
 * - `none` — no (valid) session;
 * - `pending-2fa` — password verified but TOTP not yet completed; must reach
 *   ONLY `pending-2fa`-class routes among authenticated surfaces, or
 *   login-time 2FA breaks;
 * - `billing-only` — mobile → web billing handoff session, restricted to the
 *   billing surface;
 * - `full` — fully authenticated session;
 * - `link-guest` — an unauthenticated visitor holding a shared-link
 *   credential. Never derived from a cookie (`derivePrincipal` cannot
 *   produce it) and admitted to NO route class by the HTTP matrix: the
 *   identity slice's link-credential validation constructs it, and consumers
 *   (realtime WS authz, media presign) authorize against its typed scope —
 *   the link and the one conversation it grants — by matching on the kind.
 * - `admin-actor` — a Cloudflare Access identity verified by the admin JWT
 *   pipeline stage (jose against the Access JWKS: issuer + audience + the
 *   exact-match actor allowlist, fail-closed). Never derived from a cookie
 *   (`derivePrincipal` cannot produce it) and admitted ONLY to `admin`-classed
 *   routes: admins are not product users, so every other class refuses the
 *   kind outright. `email` is the verified Access identity (the audit-row
 *   `actor`); `audience` is the Access-app AUD tag the token verified against.
 * - `trial-session` — an unauthenticated visitor running the trial pipeline.
 *   Like `link-guest`, never derived from a cookie and admitted to NO route
 *   class: the trial route constructs it from the `x-trial-token` credential,
 *   and the realtime seam authorizes it against its own trial room (the DO
 *   whose id is the session id) — never a conversation. `sessionId` is a uuid,
 *   so it scopes the trial run's idempotency-key claim.
 */
export type Principal =
  | { readonly kind: 'none' }
  | { readonly kind: 'pending-2fa'; readonly claims: SessionClaims }
  | { readonly kind: 'billing-only'; readonly claims: SessionClaims }
  | { readonly kind: 'full'; readonly claims: SessionClaims }
  | { readonly kind: 'link-guest'; readonly linkId: string; readonly conversationId: string }
  | { readonly kind: 'admin-actor'; readonly email: string; readonly audience: string }
  | { readonly kind: 'trial-session'; readonly sessionId: string };

/**
 * Maps session claims to a principal. Order is load-bearing: the 2FA gate is
 * evaluated before billingOnly, so a half-authenticated session can never
 * widen into another class. An EXPIRED pending-2FA challenge degrades to
 * `none` — the legacy middleware answered it 401 (re-login required), and the
 * identity slice re-checks expiry domain-side on the verify route.
 */
export function derivePrincipal(claims: SessionClaims | null, now: number): Principal {
  if (claims === null) return { kind: 'none' };
  if (claims.pending2FA) {
    if (claims.pending2FAExpiresAt < now) return { kind: 'none' };
    return { kind: 'pending-2fa', claims };
  }
  if (claims.billingOnly === true) return { kind: 'billing-only', claims };
  return { kind: 'full', claims };
}

export type SessionLiveness = 'active' | 'revoked';

/**
 * The session-revocation seam the pipeline's session stage runs on every
 * request that presents parseable claims. The implementation lives in the
 * identity slice (it owns the sessionActive / password-changed-at Redis
 * keys) and is injected at the composition root — the middleware never
 * imports slice internals. `revoked` covers both a missing/expired
 * sessionActive key and a cookie issued before the password last changed.
 */
export type SessionRevocationCheck = (
  redis: Redis,
  claims: SessionClaims
) => ResultAsync<SessionLiveness, DomainError>;
