import { getIronSession } from 'iron-session';
import { match } from 'ts-pattern';
import { sessionCookieOptions } from '../../../lib/context/index.js';
import { fromPromise } from '../../../lib/result/index.js';
import { unavailableError } from '../../../lib/errors/index.js';
import { redisDel, redisSet } from '../../../lib/redis/index.js';
import { IDENTITY_KEYS } from './keys.js';
import type { Redis } from '@upstash/redis';
import type { SessionClaims } from '../../../lib/context/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { DestroyCookieArgs, IssueSessionArgs, SessionKind, SessionManager } from '../ports/index.js';

/** Legacy-compatible window for completing the TOTP challenge after login. */
export const PENDING_2FA_TTL_MS = 5 * 60 * 1000;

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
 * load-bearing in `issue`: the sessionActive key is written BEFORE the
 * cookie is sealed, so a failure can never hand the client a cookie the
 * revocation check would immediately reject — and a crash between the two
 * leaves only an expiring Redis key, nothing else.
 */
export function createIdentitySessions(redis: Redis): SessionManager {
  return {
    issue: (args: IssueSessionArgs) => {
      const sessionId = crypto.randomUUID();
      const claims = buildClaims(args.userId, sessionId, args.kind, args.now);
      return redisSet(redis, IDENTITY_KEYS.sessionActive, '1', args.userId, sessionId).andThen(
        () => sealCookie(args, claims, sessionId)
      );
    },
    revoke: (session) =>
      redisDel(redis, IDENTITY_KEYS.sessionActive, session.userId, session.sessionId),
    destroyCookie: async (args: DestroyCookieArgs): Promise<void> => {
      const session = await getIronSession(
        args.request,
        args.response,
        sessionCookieOptions(args.secret, args.isProduction)
      );
      session.destroy();
    },
  };
}
