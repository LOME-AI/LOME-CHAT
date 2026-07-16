import { z } from 'zod';
import { DELETE_ACCOUNT_CONFIRMATION_PHRASE } from '@hushbox/shared';
import { fromPromise, okAsync } from '../../../lib/result/index.js';
import { unavailableError } from '../../../lib/errors/index.js';
import { runSettlement } from '../../../lib/idempotency/index.js';
import { redisSet } from '../../../lib/redis/index.js';
import {
  deleteOwnedConversationsWithinTx,
  leaveAllMembershipsWithinTx,
  ownedConversationIdsWithinTx,
} from '../../conversations/index.js';
import { requireUser } from './guards.js';
import { IDENTITY_KEYS } from './keys.js';
import { clearLockout, reserveAttempt } from './lockout.js';
import { evictUserBestEffort } from './session.js';
import { consumeStepUp, startStepUp, verifyStepUp } from './step-up.js';
import { verifyStoredTotp } from './totp.js';
import type { Database } from '@hushbox/db';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type {
  AccountDeletedEmailPort,
  AccountDeletionPurge,
  EvictUserPort,
  IdentityUsersStore,
} from '../ports/index.js';
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
  | AccountDeletionResult;

/** The executor's own outcomes — the tail of the finish-flow union. */
export type AccountDeletionResult = { readonly kind: 'deleted' } | { readonly kind: 'not-found' };

/**
 * What the hard-deletion executor itself needs. The finish flow supplies the
 * step-up gates on top; `executeAccountDeletion` is exported for the executor
 * paths a route-level proof cannot reach (the vanished-user race, injected
 * transaction failures).
 */
export interface AccountDeletionArgs {
  readonly redis: RedisClient;
  readonly store: IdentityUsersStore;
  readonly db: Database;
  /** Chat's purge helpers + the media-reclaim enqueue (composition-root bound). */
  readonly purge: AccountDeletionPurge;
  readonly accountDeletedEmail: AccountDeletedEmailPort;
  /** Realtime eviction fan-out, best-effort after the revocation watermark. */
  readonly evictUser?: EvictUserPort | undefined;
  readonly userId: string;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly now: Date;
}

export interface DeleteAccountFinishArgs extends AccountDeletionArgs {
  readonly masterSecret: string;
  readonly ke3: number[];
  readonly deleteAccountSessionId: string;
  readonly confirmationPhrase: string;
  readonly totpCode: string | undefined;
}

/**
 * Round two: a step-up finish gated by the deletion lockout. Consuming the
 * handshake is the first-delivery claim; a bad proof advances the lockout
 * window (3 attempts within a single 24-hour window — the window is also the
 * lock; legacy instead counted attempts in a 1-hour window and then locked for
 * 24 hours), a verified proof EXECUTES the hard deletion synchronously and
 * clears the window. The confirmation phrase
 * and — when the account has TOTP — a second factor gate the effect (phrase →
 * proof → TOTP → delete), matching legacy's delete-account gates.
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
  return gateTotpThenExecute(args);
}

/**
 * After a verified password proof, require a valid TOTP code when the account
 * has 2FA — reusing the shared stored-TOTP verifier (its own lockout + replay
 * protection). A TOTP-less account skips straight to the executor.
 */
function gateTotpThenExecute(
  args: DeleteAccountFinishArgs
): ResultAsync<DeleteAccountOutcome, DomainError> {
  return args.store.findById(args.userId).andThen((found) => {
    const user = requireUser(found);
    if (!user.totpEnabled) return executeAndClear(args);
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
      if (verdict.kind === 'ok') return executeAndClear(args);
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

/** Runs the executor and clears the deletion lockout once the delete committed. */
function executeAndClear(
  args: DeleteAccountFinishArgs
): ResultAsync<DeleteAccountOutcome, DomainError> {
  return executeAccountDeletion(args).andThen((outcome) =>
    outcome.kind === 'deleted'
      ? clearLockout(args.redis, IDENTITY_KEYS.deleteAccountLockout, args.userId).map(
          (): DeleteAccountOutcome => outcome
        )
      : okAsync<DeleteAccountOutcome, DomainError>(outcome)
  );
}

/**
 * The hard-deletion executor: ONE transaction deletes the account (legacy
 * ordering preserved), then the post-commit tail revokes sessions and sends
 * the confirmation. Synchronous with the request, like legacy — the response
 * is only sent after the account is gone.
 */
export function executeAccountDeletion(
  args: AccountDeletionArgs
): ResultAsync<AccountDeletionResult, DomainError> {
  return fromPromise(runDeletionTransaction(args), (cause) =>
    unavailableError('account deletion transaction failed', cause)
  ).andThen((capture) =>
    capture === null
      ? okAsync<AccountDeletionResult, DomainError>({ kind: 'not-found' })
      : revokeAndNotify(args, capture.email).map(
          (): AccountDeletionResult => ({
            kind: 'deleted',
          })
        )
  );
}

/**
 * Ordering invariants enforced inside the transaction (legacy parity):
 *   1. Lock the users row FOR UPDATE and capture the email BEFORE the cascade
 *      destroys it (racing finishes serialize here — the loser sees null).
 *   2. Capture owned-conversation ids + their content storage keys BEFORE the
 *      users delete cascades the rows away; the reclaim job's payload is the
 *      only surviving map from account to R2 ciphertext.
 *   3. Stamp conversation_members.leftAt BEFORE deleting users so the FK's
 *      userId-SET-NULL leaves rows satisfying the userId/linkId/leftAt check.
 *   4. Null messages.senderId in NON-owned conversations (senderId has no FK
 *      by design, so nothing else would clear it); owned ones die in step 5.
 *   5. Delete the owned conversations explicitly (see
 *      deleteOwnedConversationsWithinTx for why the users cascade alone
 *      aborts against membership rows this transaction rewrote).
 *   6. Insert the ANONYMOUS deletion event, then delete the users row.
 *   7. Enqueue media.reclaimUser.v1 with the captured keys — atomic with the
 *      delete (Pattern C); skipped when the account stored no media.
 * A throw anywhere rolls the whole thing back: no partial deletion exists.
 */
async function runDeletionTransaction(
  args: AccountDeletionArgs
): Promise<{ email: string } | null> {
  return runSettlement(args.db, async (tx) => {
    const locked = await args.store.lockForDeletionWithinTx(tx, args.userId);
    if (locked === null) return null;
    const ownedIds = await ownedConversationIdsWithinTx(tx, args.userId);
    const storageKeys = await args.purge.captureContentStorageKeysWithinTx(tx, ownedIds);
    await leaveAllMembershipsWithinTx(tx, args.userId, args.now);
    await args.purge.detachMessageSendersWithinTx(tx, args.userId, ownedIds);
    await deleteOwnedConversationsWithinTx(tx, args.userId);
    await args.store.insertDeletionEventWithinTx(tx, {
      deletedAt: args.now,
      ipAddress: args.ipAddress,
      userAgent: args.userAgent,
    });
    await args.store.deleteUserWithinTx(tx, args.userId);
    if (storageKeys.length > 0) {
      await args.purge.enqueueMediaReclaimWithinTx(tx, { userId: args.userId, storageKeys });
    }
    return { email: locked.email };
  });
}

/**
 * The post-commit tail, legacy order (notify before cleanup) adapted to the
 * new architecture: the pw-changed watermark stales every session issued
 * before now, the realtime fan-out closes live sockets, then the confirmation
 * email goes out. A watermark failure PROPAGATES even though the delete
 * already committed — session revocation must never silently lag a deletion
 * (the credentials rotation carries the same tradeoff); only the eviction and
 * the email are best-effort.
 */
function revokeAndNotify(args: AccountDeletionArgs, email: string): ResultAsync<void, DomainError> {
  return redisSet(args.redis, IDENTITY_KEYS.passwordChangedAt, args.now.getTime(), args.userId)
    .andThen(() => evictUserBestEffort(args.evictUser, args.userId))
    .andThen(() =>
      args.accountDeletedEmail.sendAccountDeletedEmail({ to: email }).orElse(() => okAsync())
    );
}
