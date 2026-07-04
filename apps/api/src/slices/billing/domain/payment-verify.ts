import { z } from 'zod';
import { runSettlement } from '../../../lib/idempotency/index.js';
import { jobOutcome } from '../../../lib/jobs/index.js';
import {
  CARD_DECLINED_ERROR_CODE,
  PAYMENT_VERIFY_JOB_TYPE,
  creditPaymentWithinTx,
  paymentReference,
} from './payments.js';
import type { Database } from '@hushbox/db';
import type { JobOutcome, JobRegistration } from '../../../lib/jobs/index.js';
import type {
  BillingStores,
  CaptureRecord,
  PaymentProvider,
  PaymentRecord,
} from '../ports/index.js';

type SettleDisposition = 'credited' | 'already-final' | 'completed-without-wallet';

/**
 * Failure budget before the dispatcher dead-letters the row at claim time.
 * Only transient provider failures consume it — every terminal state of the
 * pre-claim maps to `ok`, so the job succeeds for every legal payload (jobs
 * philosophy: a job that cannot reach success is a code defect).
 */
export const PAYMENT_VERIFY_MAX_FAILURES = 10;

const paymentVerifyPayloadSchema = z.object({ paymentId: z.uuid() });

export interface PaymentVerifyDeps {
  readonly db: Database;
  readonly stores: BillingStores;
  readonly provider: PaymentProvider;
}

async function resolveChargedPayment(
  deps: PaymentVerifyDeps,
  payment: PaymentRecord & { readonly helcimTransactionId: string }
): Promise<JobOutcome> {
  const status = await deps.provider.getChargeStatus(payment.helcimTransactionId);
  if (status.isErr()) {
    // An unknown transaction id can never become known — dead for explicit
    // human investigation; anything else is transient and retries.
    return status.error.code === 'not_found'
      ? jobOutcome.dead('provider does not know the transaction')
      : jobOutcome.fail(status.error.code);
  }
  if (status.value.status === 'declined') {
    const failed = await runSettlement(deps.db, (tx) =>
      deps.stores.markPaymentFailedWithinTx(
        tx,
        payment.id,
        CARD_DECLINED_ERROR_CODE,
        'awaiting_webhook'
      )
    );
    // 0 rows means the row already advanced (a racing webhook completed it) —
    // re-resolve the actual state rather than reporting a false 'failed'.
    if (failed) return jobOutcome.ok('failed');
    return verifyPayment(deps, payment.id);
  }
  // Approved and the webhook never landed: the verify job IS the reconciler —
  // the completed-claim transition and the credit commit atomically, so a
  // racing webhook and duplicate runs converge on exactly one credit.
  return jobOutcome.ok(await completeAndCreditPayment(deps, payment.id));
}

/**
 * The one exactly-once money move for a recorded charge: the completed-claim
 * transition and the deposit credit commit in a single settlement. A racing
 * webhook, a duplicate run, or a concurrent reconcile all converge here — the
 * `awaiting_webhook → completed` claim fences every one to a single credit.
 */
function completeAndCreditPayment(
  deps: PaymentVerifyDeps,
  paymentId: string
): Promise<SettleDisposition> {
  return runSettlement(deps.db, async (tx): Promise<SettleDisposition> => {
    const claimed = await deps.stores.claimPaymentCompletedWithinTx(tx, { paymentId });
    if (claimed === null) return 'already-final';
    if (claimed.userId === null) return 'completed-without-wallet';
    await creditPaymentWithinTx(deps.stores, tx, {
      paymentId: claimed.id,
      userId: claimed.userId,
      amountNanoUsd: claimed.amountNanoUsd,
    });
    return 'credited';
  });
}

/**
 * The orphaned-capture reconcile: a `pending` pre-claim whose charge captured
 * at the provider but whose transaction id was never recorded (the process
 * died between capture and record). The merchant reference — re-derived from
 * the payment id — is the only handle on that capture, since the lost
 * transaction id is what the webhook and status query both key on.
 */
async function reconcileOrExpirePending(
  deps: PaymentVerifyDeps,
  paymentId: string
): Promise<JobOutcome> {
  const lookup = await deps.provider.findCaptureByReference(paymentReference(paymentId));
  if (lookup.isErr()) return jobOutcome.fail(lookup.error.code);
  if (lookup.value.kind === 'found') {
    return reconcileFoundCapture(deps, paymentId, lookup.value.capture);
  }
  // No capture at the provider: the charge never landed — expire the pre-claim.
  const expired = await runSettlement(deps.db, (tx) =>
    deps.stores.markPaymentExpiredWithinTx(tx, paymentId)
  );
  if (expired) return jobOutcome.ok('expired');
  // The charge finalize raced ahead of the expiry — resolve the new state.
  return verifyPayment(deps, paymentId);
}

async function reconcileFoundCapture(
  deps: PaymentVerifyDeps,
  paymentId: string,
  capture: CaptureRecord
): Promise<JobOutcome> {
  if (capture.status === 'declined') {
    // The provider attempted and refused the charge: no money moved, so the
    // pre-claim fails rather than expires.
    const failed = await runSettlement(deps.db, (tx) =>
      deps.stores.markPaymentFailedWithinTx(tx, paymentId, CARD_DECLINED_ERROR_CODE, 'pending')
    );
    if (failed) return jobOutcome.ok('failed');
    return verifyPayment(deps, paymentId);
  }
  // Record the transaction id the crash lost (pending → awaiting_webhook),
  // then complete + credit through the same fence the webhook path uses. A
  // concurrent path that advanced the row first yields 0 rows — re-resolve.
  const recorded = await runSettlement(deps.db, (tx) =>
    deps.stores.markPaymentChargedWithinTx(tx, paymentId, {
      helcimTransactionId: capture.transactionId,
    })
  );
  if (!recorded) return verifyPayment(deps, paymentId);
  return jobOutcome.ok(await completeAndCreditPayment(deps, paymentId));
}

async function verifyPayment(deps: PaymentVerifyDeps, paymentId: string): Promise<JobOutcome> {
  const read = await deps.stores.readPayment(deps.db, paymentId);
  if (read.isErr()) return jobOutcome.fail(read.error.code);
  const payment = read.value;
  if (payment === null) {
    // Payments rows survive user hard-deletion (userId goes null); an absent
    // row means the payload never referenced one — a code defect, dead.
    return jobOutcome.dead('payment pre-claim row does not exist');
  }
  if (
    payment.status === 'completed' ||
    payment.status === 'failed' ||
    payment.status === 'expired'
  ) {
    return jobOutcome.ok('already-final');
  }
  if (payment.status === 'pending') {
    // Past the webhook threshold with no recorded transaction id: the charge
    // may still have captured (crash between capture and record). Search the
    // provider by the merchant reference before expiring — a found capture is
    // reconciled, an absent one expires.
    return reconcileOrExpirePending(deps, paymentId);
  }
  if (payment.helcimTransactionId === null) {
    return jobOutcome.dead('charged payment carries no transaction id');
  }
  return resolveChargedPayment(deps, {
    ...payment,
    helcimTransactionId: payment.helcimTransactionId,
  });
}

/**
 * `payment.verify.v1` — the delayed Pattern-D reconciler, enqueued in the
 * pre-claim transaction. `byEventId` class: every effect is fenced by the
 * payment row's atomic status transitions, so at-least-once redelivery is a
 * no-op after first success.
 */
export function createPaymentVerifyJobRegistration(
  deps: PaymentVerifyDeps
): JobRegistration<typeof paymentVerifyPayloadSchema> {
  return {
    type: PAYMENT_VERIFY_JOB_TYPE,
    schema: paymentVerifyPayloadSchema,
    leaseSeconds: 60,
    maxFailures: PAYMENT_VERIFY_MAX_FAILURES,
    idempotency: 'byEventId',
    handler: (execution) => verifyPayment(deps, execution.payload.paymentId),
  };
}
