import { z } from 'zod';
import { DELETE_ACCOUNT_CONFIRMATION_PHRASE } from '@hushbox/shared';
import { okAsync } from '../../../lib/result/index.js';
import { requireUser } from './guards.js';
import { IDENTITY_KEYS } from './keys.js';
import { clearLockout, reserveAttempt } from './lockout.js';
import { consumeStepUp, startStepUp, verifyStepUp } from './step-up.js';
import { verifyStoredTotp } from './totp.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { IdentityUsersStore } from '../ports/index.js';
import type { OpaqueFinishFlow } from './opaque.js';
import type { RedisClient } from './keys.js';
import type { StepUpPending } from './step-up.js';

export const deleteAccountInitBodySchema = z.object({
  ke1: z.array(z.number()).min(1),
});

export const deleteAccountFinishBodySchema = z.object({
  ke3: z.array(z.number()).min(1),
  deleteAccountSessionId: z.uuid(),
  // The client types the confirmation phrase; compared trim + lowercase against
  // DELETE_ACCOUNT_CONFIRMATION_PHRASE (no Unicode normalization — homoglyphs
  // do not match). A second factor is required only when the account has TOTP.
  confirmationPhrase: z.string().max(200),
  totpCode: z
    .string()
    .length(6)
    .regex(/^\d{6}$/)
    .optional(),
});

export interface DeleteAccountInitArgs {
  readonly redis: RedisClient;
  readonly store: IdentityUsersStore;
  readonly masterSecret: string;
  readonly userId: string;
  readonly ke1: number[];
}

/** Round one of an account-deletion request: opens a step-up challenge. */
export function startDeleteAccount(
  args: DeleteAccountInitArgs
): ResultAsync<{ readonly ke2: number[]; readonly deleteAccountSessionId: string }, DomainError> {
  return args.store.findById(args.userId).andThen((found) => {
    const user = requireUser(found);
    return startStepUp({
      redis: args.redis,
      definition: IDENTITY_KEYS.opaquePendingDeleteAccount,
      ke1: args.ke1,
      userId: args.userId,
      opaqueRegistration: user.opaqueRegistration,
      masterSecret: args.masterSecret,
    }).map((stepUp) => ({ ke2: stepUp.ke2, deleteAccountSessionId: stepUp.stepUpSessionId }));
  });
}

export type DeleteAccountOutcome =
  | { readonly kind: 'no-step-up' }
  | { readonly kind: 'locked'; readonly retryAfterSeconds: number }
  | { readonly kind: 'bad-proof' }
  | { readonly kind: 'invalid-phrase' }
  | { readonly kind: 'totp-required' }
  | { readonly kind: 'invalid-totp' }
  | { readonly kind: 'totp-not-configured' }
  | { readonly kind: 'requested' }
  | { readonly kind: 'already-requested' };

export interface DeleteAccountFinishArgs {
  readonly redis: RedisClient;
  readonly store: IdentityUsersStore;
  readonly masterSecret: string;
  readonly userId: string;
  readonly ke3: number[];
  readonly deleteAccountSessionId: string;
  readonly confirmationPhrase: string;
  readonly totpCode: string | undefined;
  readonly now: Date;
}

/**
 * Round two: a step-up finish gated by the deletion lockout. Consuming the
 * handshake is the first-delivery claim; a bad proof advances the lockout
 * window (legacy parity: 3 attempts / 24 hours), a verified proof marks the
 * deletion request and clears the window. The confirmation phrase and — when
 * the account has TOTP — a second factor gate the effect (phrase → proof →
 * TOTP → mark), matching legacy's delete-account gates.
 */
export function createDeleteAccountFinishFlow(
  args: DeleteAccountFinishArgs
): OpaqueFinishFlow<DeleteAccountOutcome> {
  let pending: StepUpPending | null = null;
  return {
    claim: () =>
      consumeStepUp(
        args.redis,
        IDENTITY_KEYS.opaquePendingDeleteAccount,
        args.deleteAccountSessionId
      ).map((state) => {
        pending = state;
        return state !== null;
      }),
    execute: () => executeDelete(args, pending),
    onDuplicate: () => okAsync<DeleteAccountOutcome, DomainError>({ kind: 'no-step-up' }),
  };
}

function executeDelete(
  args: DeleteAccountFinishArgs,
  pending: StepUpPending | null
): ResultAsync<DeleteAccountOutcome, DomainError> {
  if (pending === null) {
    throw new Error('identity: delete-account finish executed without a claimed handshake');
  }
  // The confirmation phrase is a cheap, server-state-free gate that runs BEFORE
  // the lockout reservation, so a wrong phrase never burns a deletion attempt.
  // (The byEventId claim already consumed the step-up handshake, so a wrong
  // phrase costs the client a fresh init — a deliberate consequence of the
  // claim-is-consume model, not a lockout charge.)
  if (args.confirmationPhrase.trim().toLowerCase() !== DELETE_ACCOUNT_CONFIRMATION_PHRASE) {
    return okAsync<DeleteAccountOutcome, DomainError>({ kind: 'invalid-phrase' });
  }
  // Attempt reservation before the step-up verdict: the increment is the
  // gate and the failure record at once (a success clears the counter).
  return reserveAttempt(args.redis, IDENTITY_KEYS.deleteAccountLockout, args.userId).andThen(
    (decision) => {
      if (decision.lockedOut) {
        return okAsync<DeleteAccountOutcome, DomainError>({
          kind: 'locked',
          retryAfterSeconds: decision.retryAfterSeconds,
        });
      }
      return resolveVerdict(args, pending);
    }
  );
}

function resolveVerdict(
  args: DeleteAccountFinishArgs,
  pending: StepUpPending
): ResultAsync<DeleteAccountOutcome, DomainError> {
  const verdict = verifyStepUp(pending, args.userId, args.ke3);
  if (verdict === 'session-mismatch') {
    return okAsync<DeleteAccountOutcome, DomainError>({ kind: 'no-step-up' });
  }
  if (verdict === 'bad-proof') {
    return okAsync<DeleteAccountOutcome, DomainError>({ kind: 'bad-proof' });
  }
  return gateTotpThenRequest(args);
}

/**
 * After a verified password proof, require a valid TOTP code when the account
 * has 2FA — reusing the shared stored-TOTP verifier (its own lockout + replay
 * protection). A TOTP-less account skips straight to the deletion marker.
 */
function gateTotpThenRequest(
  args: DeleteAccountFinishArgs
): ResultAsync<DeleteAccountOutcome, DomainError> {
  return args.store.findById(args.userId).andThen((found) => {
    const user = requireUser(found);
    if (!user.totpEnabled) return requestAndClear(args);
    if (args.totpCode === undefined) {
      return okAsync<DeleteAccountOutcome, DomainError>({ kind: 'totp-required' });
    }
    return verifyStoredTotp({
      redis: args.redis,
      encryptedSecret: user.totpSecretEncrypted,
      masterSecret: args.masterSecret,
      userId: args.userId,
      code: args.totpCode,
      now: args.now,
    }).andThen((verdict) => {
      if (verdict.kind === 'ok') return requestAndClear(args);
      if (verdict.kind === 'locked') {
        return okAsync<DeleteAccountOutcome, DomainError>({
          kind: 'locked',
          retryAfterSeconds: verdict.retryAfterSeconds,
        });
      }
      if (verdict.kind === 'not-configured') {
        return okAsync<DeleteAccountOutcome, DomainError>({ kind: 'totp-not-configured' });
      }
      return okAsync<DeleteAccountOutcome, DomainError>({ kind: 'invalid-totp' });
    });
  });
}

/** Marks the deletion request and clears the deletion lockout on success. */
function requestAndClear(
  args: DeleteAccountFinishArgs
): ResultAsync<DeleteAccountOutcome, DomainError> {
  return args.store
    .requestDeletion(args.userId)
    .andThen((id) =>
      clearLockout(args.redis, IDENTITY_KEYS.deleteAccountLockout, args.userId).map(
        (): DeleteAccountOutcome =>
          id === null ? { kind: 'already-requested' } : { kind: 'requested' }
      )
    );
}
