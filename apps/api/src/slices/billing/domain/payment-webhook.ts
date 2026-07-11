import { match } from 'ts-pattern';
import { SERVICE_NAMES, recordServiceEvidence } from '@hushbox/db';
import { unavailableError } from '../../../lib/errors/index.js';
import { runSettlement } from '../../../lib/idempotency/index.js';
import { enqueueWithinTx } from '../../../lib/jobs/index.js';
import { fromPromise, okAsync } from '../../../lib/result/index.js';
import { CARD_DECLINED_ERROR_CODE, creditPaymentWithinTx } from './payments.js';
import type { Database } from '@hushbox/db';
import type { DomainError } from '../../../lib/errors/index.js';
import type { SettlementTx } from '../../../lib/idempotency/index.js';
import type { EnqueueJobResult, JobRegistry } from '../../../lib/jobs/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type {
  AccountDefensePort,
  AccountLockedEmailPort,
  BillingStores,
  PaymentRecord,
} from '../ports/index.js';
import type { PaymentWebhookEvent } from './webhook-verify.js';

/**
 * `chargeback.revoke.v1` — the must-happen session revocation triggered by a
 * captured-payment chargeback. The type name is billing-owned (billing is the
 * enqueuer, as with `payment.verify.v1`); the handler is identity's (it revokes
 * every session + evicts live sockets). Defined here, consumed by identity's
 * registration factory through the billing barrel — keeping the slice import
 * direction identity → billing.
 */
export const CHARGEBACK_REVOKE_JOB_TYPE = 'chargeback.revoke.v1';

/**
 * CI service-evidence for the inbound payment-webhook seam: a row lands only
 * when `isCI`, and CI's `verify:evidence` step asserts the Hookdeck-relayed
 * Helcim webhook was actually exercised. Recorded after signature
 * verification succeeds — an unverified delivery proves nothing.
 */
export function recordPaymentWebhookEvidence(db: Database, isCI: boolean): Promise<void> {
  return recordServiceEvidence(db, isCI, SERVICE_NAMES.HOOKDECK);
}

export interface PaymentWebhookDeps {
  readonly db: Database;
  readonly stores: BillingStores;
  readonly accountDefense: AccountDefensePort;
  readonly accountLockedEmail: AccountLockedEmailPort;
  /**
   * Carries the `chargeback.revoke.v1` registration for the in-transaction
   * enqueue (the revoke job is enqueued atomically with the clawback + lock).
   */
  readonly registry: JobRegistry;
}

/**
 * What one verified webhook delivery did. `unmatched` is the only kind the
 * route answers non-2xx for: a completed event racing ahead of the charge
 * finalize has no row to match (the transaction id lands on the row only at
 * finalize), so the provider's redelivery — and, past the threshold, the
 * verify job — are the retry paths.
 */
export type PaymentWebhookDisposition =
  | { readonly kind: 'credited'; readonly paymentId: string }
  | { readonly kind: 'already-completed'; readonly paymentId: string }
  | { readonly kind: 'completed-without-wallet'; readonly paymentId: string }
  | { readonly kind: 'unmatched' }
  | { readonly kind: 'decline-recorded'; readonly paymentId: string }
  | { readonly kind: 'decline-unmatched' }
  | { readonly kind: 'clawback-posted'; readonly paymentId: string }
  | { readonly kind: 'clawback-duplicate'; readonly paymentId: string }
  | { readonly kind: 'dispute-unmatched' }
  | { readonly kind: 'dispute-orphaned'; readonly paymentId: string }
  | { readonly kind: 'notify-only' }
  | { readonly kind: 'ignored' };

export interface PaymentWebhookApplication {
  /** True when this delivery performed the effect (the byEventId claim). */
  readonly claimed: boolean;
  readonly disposition: PaymentWebhookDisposition;
  /**
   * True when this delivery newly enqueued the `chargeback.revoke.v1` job, so
   * the route fires the lossy post-commit dispatcher nudge. False on every
   * other path and on a duplicate delivery (no new job), so a replay never
   * wakes the dispatcher.
   */
  readonly wakeDispatcher: boolean;
}

function applied(
  claimed: boolean,
  disposition: PaymentWebhookDisposition,
  wakeDispatcher = false
): PaymentWebhookApplication {
  return { claimed, disposition, wakeDispatcher };
}

function applyCompleted(
  deps: PaymentWebhookDeps,
  transactionId: string
): ResultAsync<PaymentWebhookApplication, DomainError> {
  return fromPromise(
    runSettlement(deps.db, async (tx) => {
      const claimedRow = await deps.stores.claimPaymentCompletedWithinTx(tx, {
        helcimTransactionId: transactionId,
      });
      if (claimedRow === null) return null;
      if (claimedRow.userId === null) {
        return { paymentId: claimedRow.id, credited: false };
      }
      await creditPaymentWithinTx(deps.stores, tx, {
        paymentId: claimedRow.id,
        userId: claimedRow.userId,
        amountNanoUsd: claimedRow.amountNanoUsd,
      });
      return { paymentId: claimedRow.id, credited: true };
    }),
    (cause) => unavailableError('webhook credit settlement failed', cause)
  ).andThen((result) => {
    if (result !== null) {
      return okAsync(
        applied(
          true,
          result.credited
            ? { kind: 'credited', paymentId: result.paymentId }
            : { kind: 'completed-without-wallet', paymentId: result.paymentId }
        )
      );
    }
    return deps.stores
      .readPaymentByTransactionId(deps.db, transactionId)
      .map((row) =>
        row !== null && row.status === 'completed'
          ? applied(false, { kind: 'already-completed', paymentId: row.id })
          : applied(false, { kind: 'unmatched' })
      );
  });
}

function applyFailed(
  deps: PaymentWebhookDeps,
  transactionId: string
): ResultAsync<PaymentWebhookApplication, DomainError> {
  return deps.stores.readPaymentByTransactionId(deps.db, transactionId).andThen((row) => {
    if (row === null) return okAsync(applied(false, { kind: 'decline-unmatched' }));
    return fromPromise(
      runSettlement(deps.db, (tx) =>
        deps.stores.markPaymentFailedWithinTx(
          tx,
          row.id,
          CARD_DECLINED_ERROR_CODE,
          'awaiting_webhook'
        )
      ),
      (cause) => unavailableError('webhook decline settlement failed', cause)
    ).map((transitioned) =>
      transitioned
        ? applied(true, { kind: 'decline-recorded', paymentId: row.id })
        : applied(false, { kind: 'decline-unmatched' })
    );
  });
}

async function postClawbackWithinTx(
  stores: BillingStores,
  tx: SettlementTx,
  payment: PaymentRecord,
  userId: string
): Promise<'posted' | 'duplicate'> {
  const walletRef = await stores.insertWalletIfAbsentWithinTx(tx, userId, 'purchased');
  const wallet = await stores.lockWalletWithinTx(tx, walletRef.id);
  const balanceAfter = wallet.balanceNanoUsd - payment.amountNanoUsd;
  const transactionId = crypto.randomUUID();
  // The event claim: the unique leg keys dedupe per payment, so a chargeback
  // and a later reversal on the same payment claw back exactly once.
  const created = await stores.insertLedgerLegsIfAbsentWithinTx(tx, [
    {
      transactionId,
      kind: 'clawback',
      amountNanoUsd: -payment.amountNanoUsd,
      balanceAfterNanoUsd: balanceAfter,
      walletId: wallet.id,
      paymentId: payment.id,
      idempotencyKey: `clawback:${payment.id}:user`,
    },
    {
      transactionId,
      kind: 'clawback',
      amountNanoUsd: payment.amountNanoUsd,
      houseAccount: 'payments-in',
      paymentId: payment.id,
      idempotencyKey: `clawback:${payment.id}:house`,
    },
  ]);
  if (!created) return 'duplicate';
  // Unguarded by design: a negative balance is a legal state.
  await stores.updateWalletBalanceWithinTx(tx, wallet.id, balanceAfter, wallet.ledgerSeq + 1n);
  return 'posted';
}

/**
 * Enqueues the must-happen `chargeback.revoke.v1` job on the clawback
 * `SettlementTx`, so session revocation commits atomically with the clawback +
 * lock — it can never be lost the way a swallowed post-commit best-effort
 * watermark bump was. The dedupe key is per-payment, so a redelivered dispute
 * for the same payment does not double-enqueue; a distinct captured dispute for
 * the same user enqueues a fresh job (harmless — the handler is naturally
 * idempotent).
 */
function enqueueChargebackRevokeWithinTx(
  tx: SettlementTx,
  registry: JobRegistry,
  args: { readonly userId: string; readonly paymentId: string }
): Promise<EnqueueJobResult> {
  return enqueueWithinTx(tx, registry, {
    type: CHARGEBACK_REVOKE_JOB_TYPE,
    payload: { userId: args.userId },
    dedupeKey: `chargeback-revoke:${args.paymentId}`,
  });
}

/** What one clawback settlement did — posted (with its defense) or a duplicate. */
interface ClawbackAndDefense {
  readonly posted: 'posted' | 'duplicate';
  readonly locked: boolean;
  readonly lockEmail: string | null;
  readonly revokeEnqueued: boolean;
}

function disputeDisposition(
  posted: 'posted' | 'duplicate',
  paymentId: string
): PaymentWebhookDisposition {
  return posted === 'posted'
    ? { kind: 'clawback-posted', paymentId }
    : { kind: 'clawback-duplicate', paymentId };
}

function applyDisputeToPayment(
  deps: PaymentWebhookDeps,
  payment: PaymentRecord,
  userId: string
): ResultAsync<PaymentWebhookApplication, DomainError> {
  // A dispute on a payment the webhook never completed has no captured funds to
  // claw back and no capture fraud warranting a lock — surface it only.
  if (payment.status !== 'completed') {
    return okAsync(applied(false, { kind: 'notify-only' }));
  }
  return fromPromise(
    runSettlement(deps.db, async (tx): Promise<ClawbackAndDefense> => {
      const posted = await postClawbackWithinTx(deps.stores, tx, payment, userId);
      if (posted !== 'posted') {
        return { posted, locked: false, lockEmail: null, revokeEnqueued: false };
      }
      // Atomic with the clawback: the lock AND the revoke-job enqueue commit in
      // the SAME transaction, gated on the freshly-posted clawback. A lock (or
      // enqueue) failure throws and rolls the clawback back — the provider
      // redelivers and re-drives all three together, so money is never reversed
      // while the account stays open and its sessions live.
      const lock = await deps.accountDefense.lockForChargebackWithinTx(tx, userId);
      const enqueue = await enqueueChargebackRevokeWithinTx(tx, deps.registry, {
        userId,
        paymentId: payment.id,
      });
      return {
        posted,
        locked: lock.locked,
        lockEmail: lock.email,
        revokeEnqueued: enqueue.enqueued,
      };
    }),
    (cause) => unavailableError('clawback settlement failed', cause)
  ).andThen((settled) => {
    if (settled.posted !== 'posted') {
      // Duplicate delivery: the clawback already posted, so no lock, no enqueue,
      // and no wake — a replay (even after an admin unlock) performs no defense.
      return okAsync(applied(false, disputeDisposition('duplicate', payment.id)));
    }
    // Post-commit best-effort lock notification, only on a freshly-performed
    // lock (an already-locked user was notified by the earlier dispute); it
    // never blocks or fails the webhook.
    const notify: ResultAsync<unknown, DomainError> =
      settled.locked && settled.lockEmail !== null
        ? deps.accountLockedEmail
            .sendAccountLockedEmail({ to: settled.lockEmail })
            .orElse(() => okAsync())
        : okAsync();
    return notify.map(() =>
      applied(true, disputeDisposition('posted', payment.id), settled.revokeEnqueued)
    );
  });
}

function applyDispute(
  deps: PaymentWebhookDeps,
  transactionId: string
): ResultAsync<PaymentWebhookApplication, DomainError> {
  return deps.stores.readPaymentByTransactionId(deps.db, transactionId).andThen((payment) => {
    if (payment === null) return okAsync(applied(false, { kind: 'dispute-unmatched' }));
    if (payment.userId === null) {
      return okAsync(applied(false, { kind: 'dispute-orphaned', paymentId: payment.id }));
    }
    return applyDisputeToPayment(deps, payment, payment.userId);
  });
}

/**
 * Applies one signature-verified Helcim event. Every effect is claim-fenced
 * in Postgres (status transition or unique leg keys), so the route's
 * `byEventId` composition gets a duplicate- and race-safe executor; the
 * dispute taxonomy is enforced here — auto-defense (clawback + lock) only on a
 * chargeback or reversal against a completed payment; a dispute on a
 * non-completed payment, inquiries, and retrievals notify only.
 */
export function applyPaymentWebhookEvent(
  deps: PaymentWebhookDeps,
  event: PaymentWebhookEvent
): ResultAsync<PaymentWebhookApplication, DomainError> {
  return match(event)
    .with({ type: 'payment.completed' }, ({ transactionId }) => applyCompleted(deps, transactionId))
    .with({ type: 'payment.failed' }, ({ transactionId }) => applyFailed(deps, transactionId))
    .with({ type: 'dispute.chargeback' }, ({ transactionId }) => applyDispute(deps, transactionId))
    .with({ type: 'dispute.reversal' }, ({ transactionId }) => applyDispute(deps, transactionId))
    .with({ type: 'dispute.inquiry' }, () => okAsync(applied(false, { kind: 'notify-only' })))
    .with({ type: 'dispute.retrieval' }, () => okAsync(applied(false, { kind: 'notify-only' })))
    .with({ type: 'unrecognized' }, () => okAsync(applied(false, { kind: 'ignored' })))
    .exhaustive();
}
