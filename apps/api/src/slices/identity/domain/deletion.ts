import { z } from 'zod';
import { okAsync } from '../../../lib/result/index.js';
import { requireUser } from './guards.js';
import { IDENTITY_KEYS } from './keys.js';
import { clearLockout, reserveAttempt } from './lockout.js';
import { consumeStepUp, startStepUp, verifyStepUp } from './step-up.js';
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
  | { readonly kind: 'requested' }
  | { readonly kind: 'already-requested' };

export interface DeleteAccountFinishArgs {
  readonly redis: RedisClient;
  readonly store: IdentityUsersStore;
  readonly userId: string;
  readonly ke3: number[];
  readonly deleteAccountSessionId: string;
}

/**
 * Round two: a step-up finish gated by the deletion lockout. Consuming the
 * handshake is the first-delivery claim; a bad proof advances the lockout
 * window (legacy parity: 3 attempts / 1 hour), a verified proof marks the
 * deletion request and clears the window.
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
  return args.store
    .requestDeletion(args.userId)
    .andThen((id) =>
      clearLockout(args.redis, IDENTITY_KEYS.deleteAccountLockout, args.userId).map(
        (): DeleteAccountOutcome =>
          id === null ? { kind: 'already-requested' } : { kind: 'requested' }
      )
    );
}
