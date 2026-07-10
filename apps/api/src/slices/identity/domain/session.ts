import { getIronSession } from 'iron-session';
import { match } from 'ts-pattern';
import { sessionCookieOptions } from '../../../lib/context/index.js';
import { fromPromise, okAsync } from '../../../lib/result/index.js';
import { unavailableError } from '../../../lib/errors/index.js';
import { redisDel, redisSet } from '../../../lib/redis/index.js';
import { IDENTITY_KEYS } from './keys.js';
import type { SessionClaims } from '../../../lib/context/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { EvictUserPort } from '../ports/index.js';
import type { RedisClient } from './keys.js';

/** Legacy-compatible window for completing the TOTP challenge after login. */
export const PENDING_2FA_TTL_MS = 5 * 60 * 1000;

/**
 * The three session shapes this slice issues. `full` and `pending-2fa` come
 * from the login flow; `billing-only` is consumed by the billing-portal
 * token login (the mobile → web handoff), which restricts the session to
 * `billing-token`-class routes via the principal derivation.
 */
export type SessionKind = 'full' | 'pending-2fa' | 'billing-only';

export interface IssueSessionArgs {
  readonly request: Request;
  readonly response: Response;
  readonly redis: RedisClient;
  /** The fail-fast-validated IRON_SESSION_SECRET, never a raw env read. */
  readonly secret: string;
  readonly isProduction: boolean;
  readonly userId: string;
  readonly kind: SessionKind;
  readonly now: number;
  /**
   * Caller-provided session id. The billing-portal token login derives it
   * deterministically from the login token so replays converge on ONE
   * session (same sessionActive key, no orphans). Omitted → fresh uuid.
   */
  readonly sessionId?: string;
}

export interface DestroyCookieArgs {
  readonly request: Request;
  readonly response: Response;
  readonly secret: string;
  readonly isProduction: boolean;
}

function buildClaims(
  userId: string,
  sessionId: string,
  kind: SessionKind,
  now: number
): SessionClaims {
  const base = { userId, sessionId, createdAt: now };
  return match(kind)
    .with('full', () => ({ ...base, pending2FA: false, pending2FAExpiresAt: 0 }))
    .with('pending-2fa', () => ({
      ...base,
      pending2FA: true,
      pending2FAExpiresAt: now + PENDING_2FA_TTL_MS,
    }))
    .with('billing-only', () => ({
      ...base,
      pending2FA: false,
      pending2FAExpiresAt: 0,
      billingOnly: true,
    }))
    .exhaustive();
}

function sealCookie(
  args: IssueSessionArgs,
  claims: SessionClaims,
  sessionId: string
): ResultAsync<{ sessionId: string }, DomainError> {
  return fromPromise(
    (async (): Promise<{ sessionId: string }> => {
      const session = await getIronSession<SessionClaims>(
        args.request,
        args.response,
        sessionCookieOptions(args.secret, args.isProduction)
      );
      Object.assign(session, claims);
      await session.save();
      return { sessionId };
    })(),
    (cause) => unavailableError('session cookie sealing failed', cause)
  );
}

/**
 * Session issuance over the sealed cookie + sessionActive key. Order is
 * load-bearing: the sessionActive key is written BEFORE the cookie is
 * sealed, so a failure can never hand the client a cookie the revocation
 * check would immediately reject — and a crash between the two leaves only
 * an expiring Redis key, nothing else.
 */
export function issueSession(
  args: IssueSessionArgs
): ResultAsync<{ readonly sessionId: string }, DomainError> {
  const sessionId = args.sessionId ?? crypto.randomUUID();
  const claims = buildClaims(args.userId, sessionId, args.kind, args.now);
  return redisSet(args.redis, IDENTITY_KEYS.sessionActive, '1', args.userId, sessionId).andThen(
    () => sealCookie(args, claims, sessionId)
  );
}

/**
 * Fans a realtime eviction out for a revoked user, best-effort: an absent
 * capability (a caller that has not wired it) and any fan-out failure both
 * resolve ok, so eviction never fails or gates the revocation. The closed
 * sockets plus the WS-upgrade re-auth are what make the revocation effective;
 * this is the push half, backstopped by the fail-closed broadcast-time
 * membership check when the fan-out cannot run.
 */
export function evictUserBestEffort(
  evictUser: EvictUserPort | undefined,
  userId: string
): ResultAsync<void, DomainError> {
  if (evictUser === undefined) return okAsync();
  return fromPromise(evictUser.evictUser(userId), (cause) =>
    unavailableError('realtime eviction fan-out failed', cause)
  ).orElse(() => okAsync());
}

/**
 * Deletes the sessionActive key — the revocation check answers `revoked`
 * from the next request on. Redis DEL converges atomically whether or not
 * the key still exists, which is what makes logout naturally idempotent.
 *
 * After the revocation state is written, a realtime eviction fans out to the
 * user's live rooms (best-effort — never fails or blocks the revoke). Because
 * chargeback lock, logout, and 2FA-login rotation all revoke through here, one
 * wiring covers every session-revocation path (ARCHITECTURE §15).
 */
export function revokeSession(
  redis: RedisClient,
  session: { readonly userId: string; readonly sessionId: string },
  evictUser?: EvictUserPort
): ResultAsync<void, DomainError> {
  return redisDel(redis, IDENTITY_KEYS.sessionActive, session.userId, session.sessionId).andThen(
    () => evictUserBestEffort(evictUser, session.userId)
  );
}

/** Sets the expired removal cookie on the response. */
export async function destroySessionCookie(args: DestroyCookieArgs): Promise<void> {
  const session = await getIronSession(
    args.request,
    args.response,
    sessionCookieOptions(args.secret, args.isProduction)
  );
  session.destroy();
}
