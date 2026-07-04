import { match } from 'ts-pattern';
import { SERVICE_NAMES, recordServiceEvidence } from '@hushbox/db';
import { unavailableError } from '../../../lib/errors/index.js';
import { runSettlement } from '../../../lib/idempotency/index.js';
import { fromPromise, okAsync } from '../../../lib/result/index.js';
import { CARD_DECLINED_ERROR_CODE, creditPaymentWithinTx } from './payments.js';
import type { Database } from '@hushbox/db';
import type { DomainError } from '../../../lib/errors/index.js';
import type { SettlementTx } from '../../../lib/idempotency/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type {
  AccountDefensePort,
  AccountLockedEmailPort,
  BillingStores,
  PaymentRecord,
} from '../ports/index.js';
import type { PaymentWebhookEvent } from './webhook-verify.js';

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
}

function applied(
  claimed: boolean,
  disposition: PaymentWebhookDisposition
): PaymentWebhookApplication {
  return { claimed, disposition };
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
 * Locks the account, then sends the lock notification only when this call
 * performed the transition (an already-locked account sends nothing). A lock
 * failure surfaces (the route answers non-2xx); the email is best-effort. The
 * caller gates this on a first-time dispute application — see
 * `applyDisputeToPayment`.
 */
function lockAndNotify(
  deps: PaymentWebhookDeps,
  userId: string
): ResultAsync<'locked' | 'already-locked', DomainError> {
  return deps.accountDefense.lockForChargeback({ userId }).andThen(({ locked, email }) => {
    if (!locked || email === null) return okAsync('already-locked' as const);
    return deps.accountLockedEmail
      .sendAccountLockedEmail({ to: email })
      .orElse(() => okAsync())
      .map(() => 'locked' as const);
  });
}

type ClawbackResult = 'posted' | 'duplicate' | 'skipped';

function disputeDisposition(posted: ClawbackResult, paymentId: string): PaymentWebhookDisposition {
  return (
    match<ClawbackResult, PaymentWebhookDisposition>(posted)
      .with('posted', () => ({ kind: 'clawback-posted', paymentId }))
      .with('duplicate', () => ({ kind: 'clawback-duplicate', paymentId }))
      // A dispute on a payment that never completed has no captured funds to
      // claw back and no fraud exposure warranting a lock — surface it only.
      .with('skipped', () => ({ kind: 'notify-only' }))
      .exhaustive()
  );
}

function applyDisputeToPayment(
  deps: PaymentWebhookDeps,
  payment: PaymentRecord,
  userId: string
): ResultAsync<PaymentWebhookApplication, DomainError> {
  // Clawback only reverses a credit that landed; a dispute on a payment the
  // webhook never completed has no captured funds, so it neither claws back nor
  // locks — the account lock is defensive against real capture fraud only.
  const clawback: ResultAsync<ClawbackResult, DomainError> =
    payment.status === 'completed'
      ? fromPromise(
          runSettlement(deps.db, (tx) => postClawbackWithinTx(deps.stores, tx, payment, userId)),
          (cause) => unavailableError('clawback settlement failed', cause)
        )
      : okAsync('skipped' as const);
  return clawback.andThen((posted) => {
    // The lock + email fire only when this delivery newly posted the clawback.
    // The clawback leg key is permanently unique, so a duplicate delivery — or
    // a dispute on a non-completed payment (no clawback at all) — performs no
    // defense, making the lock fire at-most-once-ever per captured dispute: a
    // replay after an admin unlock cannot re-lock the genuine victim (the
    // byEventId envelope's retention is finite; this guarantee is not).
    const defended: ResultAsync<unknown, DomainError> =
      posted === 'posted' ? lockAndNotify(deps, userId) : okAsync();
    return defended.map(() => applied(posted === 'posted', disputeDisposition(posted, payment.id)));
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
