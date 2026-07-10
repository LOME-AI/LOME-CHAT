import { z } from 'zod';
import {
  decryptAndVerifyTotp,
  deriveTotpEncryptionKey,
  encryptTotpSecret,
  generateTotpSecret,
  generateTotpUri,
  verifyTotpToken,
} from '@hushbox/crypto';
import { textEncoder } from '@hushbox/shared';
import { ResultAsync, okAsync } from '../../../lib/result/index.js';
import { redisGetDel, redisSet, redisSetNx } from '../../../lib/redis/index.js';
import { requireUser } from './guards.js';
import { IDENTITY_KEYS } from './keys.js';
import { clearLockout, reserveAttempt } from './lockout.js';
import { issueSession, revokeSession } from './session.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type {
  EvictUserPort,
  IdentityUserRecord,
  IdentityUsersStore,
  TwoFactorEnabledEmailPort,
} from '../ports/index.js';
import type { OpaqueFinishFlow } from './opaque.js';
import type { RedisClient } from './keys.js';

/** A six-digit TOTP code — the body shape for setup-verify and login 2FA. */
export const totpCodeBodySchema = z.object({
  code: z
    .string()
    .length(6)
    .regex(/^\d{6}$/),
});

export interface TotpSetupArgs {
  readonly redis: RedisClient;
  readonly store: IdentityUsersStore;
  readonly masterSecret: string;
  readonly userId: string;
}

export type TotpSetupOutcome =
  | { readonly kind: 'already-enabled' }
  | { readonly kind: 'started'; readonly totpUri: string; readonly secret: string };

/**
 * Round one of TOTP enrollment: mints a fresh secret, encrypts it under the
 * TOTP key derived from the OPAQUE master secret, and stashes both the
 * plaintext (to confirm the first code against) and the blob (to persist on
 * confirm) in single-use pending state. Refuses when TOTP is already enabled.
 */
export function startTotpSetup(args: TotpSetupArgs): ResultAsync<TotpSetupOutcome, DomainError> {
  return args.store.findById(args.userId).andThen((found) => {
    const user = requireUser(found);
    if (user.totpEnabled)
      return okAsync<TotpSetupOutcome, DomainError>({ kind: 'already-enabled' });
    const key = deriveTotpEncryptionKey(textEncoder.encode(args.masterSecret));
    const secret = generateTotpSecret();
    const totpUri = generateTotpUri(user.email, secret);
    const encryptedBlob = encryptTotpSecret(secret, key);
    return redisSet(
      args.redis,
      IDENTITY_KEYS.totpPendingSetup,
      { secret, encryptedBlob: [...encryptedBlob] },
      args.userId
    ).map((): TotpSetupOutcome => ({ kind: 'started', totpUri, secret }));
  });
}

export type TotpVerifySetupOutcome =
  | { readonly kind: 'no-pending' }
  | { readonly kind: 'invalid-code' }
  | { readonly kind: 'enabled' }
  | { readonly kind: 'already-enabled' };

export interface TotpVerifySetupFlowArgs {
  readonly redis: RedisClient;
  readonly store: IdentityUsersStore;
  readonly userId: string;
  readonly code: string;
  readonly now: Date;
  /** Best-effort security notification dispatched when TOTP flips to enabled. */
  readonly enabledEmail: TwoFactorEnabledEmailPort;
}

/**
 * Round two of enrollment as a `byEventId` composition: consuming the pending
 * setup (atomic GETDEL) is the first-delivery claim, so a replayed or racing
 * confirm finds nothing. A wrong code burns the enrollment — the client
 * re-runs setup for a fresh secret (single-use doctrine over retry UX).
 */
export function createTotpVerifySetupFlow(
  args: TotpVerifySetupFlowArgs
): OpaqueFinishFlow<TotpVerifySetupOutcome> {
  let pending: { secret: string; encryptedBlob: number[] } | null = null;
  return {
    claim: () =>
      redisGetDel(args.redis, IDENTITY_KEYS.totpPendingSetup, args.userId).map((state) => {
        pending = state;
        return state !== null;
      }),
    execute: () => executeVerifySetup(args, pending),
    onDuplicate: () => okAsync<TotpVerifySetupOutcome, DomainError>({ kind: 'no-pending' }),
  };
}

function executeVerifySetup(
  args: TotpVerifySetupFlowArgs,
  pending: { secret: string; encryptedBlob: number[] } | null
): ResultAsync<TotpVerifySetupOutcome, DomainError> {
  if (pending === null) {
    throw new Error('identity: TOTP verify executed without a claimed pending setup');
  }
  return ResultAsync.fromSafePromise(
    verifyTotpToken({ secret: pending.secret, code: args.code, now: args.now })
  ).andThen((result) => {
    if (!result.ok) return okAsync<TotpVerifySetupOutcome, DomainError>({ kind: 'invalid-code' });
    return args.store
      .enableTotp(args.userId, new Uint8Array(pending.encryptedBlob))
      .andThen((outcome) =>
        outcome === 'enabled'
          ? notifyTotpEnabled(args).map((): TotpVerifySetupOutcome => ({ kind: 'enabled' }))
          : okAsync<TotpVerifySetupOutcome, DomainError>({ kind: 'already-enabled' })
      );
  });
}

/**
 * Best-effort TOTP-enabled security notification: resolves the account's
 * address + name and sends. A lookup or send failure is swallowed so it never
 * fails the enrollment (the transition already committed).
 */
function notifyTotpEnabled(args: TotpVerifySetupFlowArgs): ResultAsync<void, DomainError> {
  return args.store
    .findById(args.userId)
    .andThen((user) =>
      user?.email
        ? args.enabledEmail.sendTwoFactorEnabledEmail({ to: user.email, userName: user.username })
        : okAsync()
    )
    .orElse(() => okAsync());
}

export type StoredTotpVerdict =
  | { readonly kind: 'locked'; readonly retryAfterSeconds: number }
  | { readonly kind: 'not-configured' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'ok' };

export interface VerifyStoredTotpArgs {
  readonly redis: RedisClient;
  readonly encryptedSecret: Uint8Array | null;
  readonly masterSecret: string;
  readonly userId: string;
  readonly code: string;
  readonly now: Date;
}

/**
 * Verifies a submitted code against the user's stored encrypted secret, with
 * an attempt-reservation lockout and single-use replay protection. Shared by
 * the login 2FA promotion and the 2FA-disable step-up. The attempt is
 * reserved with an atomic increment BEFORE verification — the reservation IS
 * the failure record, so at most the window's cap of codes is ever verified
 * even under concurrency; attempts made while locked still advance the count
 * (never the window). A success clears the whole counter. A secret that
 * fails to decrypt is server-side corruption — a defect, never a
 * distinguishable client outcome.
 */
export function verifyStoredTotp(
  args: VerifyStoredTotpArgs
): ResultAsync<StoredTotpVerdict, DomainError> {
  return reserveAttempt(args.redis, IDENTITY_KEYS.twoFactorLockout, args.userId).andThen(
    (decision) => {
      if (decision.lockedOut) {
        return okAsync<StoredTotpVerdict, DomainError>({
          kind: 'locked',
          retryAfterSeconds: decision.retryAfterSeconds,
        });
      }
      if (args.encryptedSecret === null) {
        return okAsync<StoredTotpVerdict, DomainError>({ kind: 'not-configured' });
      }
      return checkReplayThenVerify(args, args.encryptedSecret);
    }
  );
}

/**
 * The used-code marker is claimed atomically (SET NX) BEFORE verification, so
 * exactly one of N concurrent submissions of the same code can be accepted; a
 * lost claim answers the same invalid outcome as a replay. A code whose claim
 * won but whose verification then failed stays burned for the marker TTL —
 * single-use doctrine over retry UX (the next TOTP period mints a fresh code).
 */
function checkReplayThenVerify(
  args: VerifyStoredTotpArgs,
  encryptedSecret: Uint8Array
): ResultAsync<StoredTotpVerdict, DomainError> {
  return redisSetNx(args.redis, IDENTITY_KEYS.totpUsedCode, '1', args.userId, args.code).andThen(
    (claimed) => {
      if (!claimed) return okAsync<StoredTotpVerdict, DomainError>({ kind: 'invalid' });
      return ResultAsync.fromSafePromise(
        decryptAndVerifyTotp({
          masterSecret: textEncoder.encode(args.masterSecret),
          encryptedSecret,
          code: args.code,
          now: args.now,
        })
      ).andThen((result) => {
        if (result.ok) return acceptCode(args);
        if (result.reason === 'decrypt-failed') {
          throw new Error('identity: stored TOTP secret failed to decrypt');
        }
        return okAsync<StoredTotpVerdict, DomainError>({ kind: 'invalid' });
      });
    }
  );
}

function acceptCode(args: VerifyStoredTotpArgs): ResultAsync<StoredTotpVerdict, DomainError> {
  return clearLockout(args.redis, IDENTITY_KEYS.twoFactorLockout, args.userId).map(
    (): StoredTotpVerdict => ({ kind: 'ok' })
  );
}

export interface VerifyUserTotpArgs {
  readonly redis: RedisClient;
  readonly store: IdentityUsersStore;
  readonly masterSecret: string;
  readonly userId: string;
  readonly code: string;
  readonly now: Date;
}

/**
 * Resolves the authenticated user's row and verifies the code against its
 * stored encrypted secret — the shared front half of the login-2FA promotion
 * and the 2FA-disable second factor.
 */
export function verifyUserTotp(
  args: VerifyUserTotpArgs
): ResultAsync<{ user: IdentityUserRecord; verdict: StoredTotpVerdict }, DomainError> {
  return args.store.findById(args.userId).andThen((found) => {
    const user = requireUser(found);
    return verifyStoredTotp({
      redis: args.redis,
      encryptedSecret: user.totpSecretEncrypted,
      masterSecret: args.masterSecret,
      userId: args.userId,
      code: args.code,
      now: args.now,
    }).map((verdict) => ({ user, verdict }));
  });
}

export interface Login2faArgs extends VerifyUserTotpArgs {
  readonly sessionId: string;
  readonly request: Request;
  readonly response: Response;
  readonly secret: string;
  readonly isProduction: boolean;
  /**
   * Realtime eviction fan-out, invoked best-effort when the promotion revokes
   * the pending-2fa session. Optional: absent until the worker wires it
   * (ARCHITECTURE §15).
   */
  readonly evictUser?: EvictUserPort;
}

export type Login2faOutcome =
  | { readonly kind: 'locked'; readonly retryAfterSeconds: number }
  | { readonly kind: 'not-configured' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'promoted'; readonly user: IdentityUserRecord };

/**
 * Promotes a pending-2FA session to full after a verified TOTP code: rotates
 * the session (old sessionActive revoked, a fresh full session minted) so the
 * pending cookie can never be replayed as a full one.
 */
export function verifyLogin2fa(args: Login2faArgs): ResultAsync<Login2faOutcome, DomainError> {
  return verifyUserTotp(args).andThen(({ user, verdict }) => {
    if (verdict.kind !== 'ok') return okAsync<Login2faOutcome, DomainError>(verdict);
    return rotateToFull(args, user);
  });
}

function rotateToFull(
  args: Login2faArgs,
  user: IdentityUserRecord
): ResultAsync<Login2faOutcome, DomainError> {
  return revokeSession(
    args.redis,
    { userId: args.userId, sessionId: args.sessionId },
    args.evictUser
  )
    .andThen(() =>
      issueSession({
        request: args.request,
        response: args.response,
        redis: args.redis,
        secret: args.secret,
        isProduction: args.isProduction,
        userId: args.userId,
        kind: 'full',
        now: args.now.getTime(),
      })
    )
    .map((): Login2faOutcome => ({ kind: 'promoted', user }));
}
