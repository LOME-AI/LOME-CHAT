import { z } from 'zod';
import { okAsync } from '../../../lib/result/index.js';
import { IDENTITY_KEYS } from './keys.js';
import { consumeRateLimit } from './rate-limit.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type {
  ConsumeEmailVerificationOutcome,
  IdentityVerificationStore,
  VerificationEmailPort,
} from '../ports/index.js';
import type { RedisClient } from './keys.js';

/** Single-use email-verification token lifetime (legacy parity: 24 hours). */
export const EMAIL_VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export const verifyEmailBodySchema = z.object({
  token: z.string().min(1),
});

export const resendVerificationBodySchema = z.object({
  email: z.email().max(254),
});

export interface VerifyEmailArgs {
  readonly store: IdentityVerificationStore;
  readonly token: string;
  readonly now: Date;
}

/**
 * Consumes a verification token and flips `emailVerified` in one transaction
 * (the store enforces atomicity + single-use). The token itself is the
 * idempotency credential (`token-is-key`): a replay finds nothing consumed and
 * answers `invalid`.
 */
export function verifyEmailToken(
  args: VerifyEmailArgs
): ResultAsync<ConsumeEmailVerificationOutcome, DomainError> {
  return args.store.consumeEmailVerification(args.token, args.now);
}

export interface ResendVerificationArgs {
  readonly redis: RedisClient;
  readonly store: IdentityVerificationStore;
  readonly emailPort: VerificationEmailPort;
  readonly email: string;
  readonly now: number;
}

export type ResendVerificationOutcome =
  | { readonly kind: 'rate-limited'; readonly retryAfterSeconds: number }
  | { readonly kind: 'ok' };

/**
 * Issues a fresh verification token and sends it, enumeration-safely: the
 * per-email throttle runs before the existence check (so a known and an
 * unknown address are throttled identically), the response is always the same
 * `ok` shape, and an unknown (or already-verified) address performs a
 * decoy store write mirroring the known path's token issue instead of
 * returning early. The residual asymmetry is the external send itself, which
 * cannot be mirrored without sending mail. The email send is best-effort —
 * its failure is swallowed so a transient sender outage never blocks or leaks.
 */
export function resendVerification(
  args: ResendVerificationArgs
): ResultAsync<ResendVerificationOutcome, DomainError> {
  const email = args.email.toLowerCase();
  return consumeRateLimit(args.redis, IDENTITY_KEYS.resendVerifyRateLimit, email, args.now).andThen(
    (decision) => {
      if (!decision.allowed) {
        return okAsync<ResendVerificationOutcome, DomainError>({
          kind: 'rate-limited',
          retryAfterSeconds: decision.retryAfterSeconds,
        });
      }
      return args.store.findUnverifiedByEmail(email).andThen((user) => {
        if (user === null) {
          return args.store
            .issueVerificationDecoy(crypto.randomUUID())
            .map((): ResendVerificationOutcome => ({ kind: 'ok' }));
        }
        return issueAndSend(args, email, user.id, user.username);
      });
    }
  );
}

function issueAndSend(
  args: ResendVerificationArgs,
  email: string,
  userId: string,
  userName: string
): ResultAsync<ResendVerificationOutcome, DomainError> {
  const token = crypto.randomUUID();
  const expiresAt = new Date(args.now + EMAIL_VERIFY_TOKEN_TTL_MS);
  return args.store.issueEmailVerification(userId, token, expiresAt).andThen(() =>
    args.emailPort
      .sendVerificationEmail({ to: email, token, userName })
      // Best-effort: a sender failure must not fail (or leak through) the request.
      .orElse(() => okAsync())
      .map((): ResendVerificationOutcome => ({ kind: 'ok' }))
  );
}
