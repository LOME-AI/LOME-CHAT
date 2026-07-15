import { z } from 'zod';
import { MIN_DEPOSIT_USD, NANO_USD_PER_CENT, NanoUSD, nanoUSD } from '@hushbox/shared';
import { conflictError, unavailableError, validationError } from '../../../lib/errors/index.js';
import { byExternalPreClaim, runSettlement } from '../../../lib/idempotency/index.js';
import { enqueueWithinTx } from '../../../lib/jobs/index.js';
import { errAsync, fromPromise, okAsync } from '../../../lib/result/index.js';
import type { Database } from '@hushbox/db';
import type { Principal } from '../../../lib/context/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { DbWriter, Idempotent, SettlementTx } from '../../../lib/idempotency/index.js';
import type { EnqueueJobResult, JobRegistry } from '../../../lib/jobs/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type {
  BillingStores,
  ChargeOutcome,
  PaymentProvider,
  PaymentRecord,
} from '../ports/index.js';

/** Product spec (README pricing): card loading starts at $5 (= 5·10^9 nano-USD). */
export const PAYMENT_MINIMUM_NANO_USD = BigInt(MIN_DEPOSIT_USD) * 100n * NANO_USD_PER_CENT;

/** The only decline detail persisted — a code, never provider freeform text. */
export const CARD_DECLINED_ERROR_CODE = 'card_declined';

export const PAYMENT_VERIFY_JOB_TYPE = 'payment.verify.v1';

/**
 * The merchant reference submitted to Helcim as the charge's `invoiceNumber`,
 * re-derived from the payment id alone at verify time — no stored column. It
 * is the uuid's 32 hex digits with hyphens stripped: Helcim's
 * `GET /card-transactions?invoiceNumber=` search filters on it, whereas the
 * pre-claim id forwarded as the idempotency-key header is not searchable. The
 * length assertion fails fast if a non-uuid id ever reaches here (a defect).
 */
export function paymentReference(paymentId: string): string {
  const reference = paymentId.replaceAll('-', '').toLowerCase();
  if (reference.length !== 32) {
    throw new Error('billing: payment id is not a 32-hex-digit uuid');
  }
  return reference;
}

/**
 * The webhook threshold: the delayed verify job fires this long after the
 * pre-claim. Past it, an unresolved pre-claim is reconciled against the
 * provider (`awaiting_webhook`) or expired (`pending` — the charge call never
 * finished and no transaction id exists to query by).
 */
export const PAYMENT_VERIFY_DELAY_SECONDS = 30 * 60;

/** Request body for the charge-initiation route (amounts as NanoUSD strings). */
export const initiatePaymentBodySchema = z.object({
  amountNanoUsd: NanoUSD,
  cardToken: z.string().min(1),
  customerCode: z.string().min(1),
});

/**
 * The payer's identity from the pipeline principal. The charge route is
 * `billing-token`-class — the mobile → web billing handoff pays with a
 * billing-only session — so both session kinds are legal; anything else here
 * is a composition defect.
 */
export function payerUserId(principal: Principal): string {
  if (principal.kind !== 'full' && principal.kind !== 'billing-only') {
    throw new Error('billing: payment route reached without a session principal');
  }
  return principal.claims.userId;
}

export interface InitiateCardPaymentDeps {
  readonly db: Database;
  readonly stores: BillingStores;
  readonly provider: PaymentProvider;
  readonly registry: JobRegistry;
}

export interface InitiateCardPaymentArgs {
  readonly userId: string;
  readonly amountNanoUsd: bigint;
  readonly cardToken: string;
  readonly customerCode: string;
  readonly ipAddress: string;
  /** The client's `Idempotency-Key` header value (scoped per user in storage). */
  readonly idempotencyKey: string;
  readonly now: Date;
}

export interface CardPaymentOutcome {
  readonly paymentId: string;
  readonly status: 'awaiting_webhook' | 'completed' | 'failed' | 'expired';
  readonly amountNanoUsd: bigint;
}

/**
 * A pre-claim replay maps straight off the row; `pending` is unreachable here
 * (a pending claim always re-runs the charge first) and therefore a defect.
 */
export function cardPaymentOutcomeOf(payment: PaymentRecord): CardPaymentOutcome {
  if (payment.status === 'pending') {
    throw new Error('card payment outcome requested for a still-pending pre-claim');
  }
  return {
    paymentId: payment.id,
    status: payment.status,
    amountNanoUsd: payment.amountNanoUsd,
  };
}

interface ChargeClaim {
  readonly payment: PaymentRecord;
  readonly created: boolean;
}

type ExternalCharge =
  | { readonly kind: 'replay' }
  | { readonly kind: 'charged'; readonly outcome: ChargeOutcome };

function validateChargeAmount(amountNanoUsd: bigint): DomainError | null {
  if (amountNanoUsd < PAYMENT_MINIMUM_NANO_USD) {
    return validationError('payment amount is below the minimum');
  }
  if (amountNanoUsd % NANO_USD_PER_CENT !== 0n) {
    return validationError('payment amount must be whole cents');
  }
  return null;
}

function preClaimPayment(
  deps: InitiateCardPaymentDeps,
  args: InitiateCardPaymentArgs
): ResultAsync<ChargeClaim, DomainError> {
  return fromPromise(
    runSettlement(deps.db, async (tx) => {
      const claim = await deps.stores.insertPaymentIfAbsentWithinTx(tx, {
        userId: args.userId,
        amountNanoUsd: args.amountNanoUsd,
        // User-scoped so two users choosing the same client key never collide
        // on the global unique column.
        idempotencyKey: `pay:${args.userId}:${args.idempotencyKey}`,
      });
      if (claim.created) {
        await enqueuePaymentVerifyWithinTx(tx, deps.registry, {
          paymentId: claim.payment.id,
          now: args.now,
        });
      }
      return claim;
    }),
    (cause) => unavailableError('payment pre-claim failed', cause)
  ).andThen((claim) => {
    if (
      !claim.created &&
      (claim.payment.userId !== args.userId || claim.payment.amountNanoUsd !== args.amountNanoUsd)
    ) {
      return errAsync(conflictError('idempotency key reused with a different payment body'));
    }
    return okAsync(claim);
  });
}

function chargeExternal(
  deps: InitiateCardPaymentDeps,
  args: InitiateCardPaymentArgs,
  claim: ChargeClaim
): ResultAsync<ExternalCharge, DomainError> {
  // Only a pending pre-claim charges: a fresh claim, or a crash-recovery retry
  // re-sending with the SAME provider key (the payment row id), which the
  // provider replays instead of capturing twice.
  if (claim.payment.status !== 'pending') {
    return okAsync<ExternalCharge, DomainError>({ kind: 'replay' });
  }
  return deps.provider
    .charge({
      idempotencyKey: claim.payment.id,
      reference: paymentReference(claim.payment.id),
      amount: nanoUSD(args.amountNanoUsd),
      cardToken: args.cardToken,
      customerCode: args.customerCode,
      ipAddress: args.ipAddress,
    })
    .map((outcome): ExternalCharge => ({ kind: 'charged', outcome }));
}

function finalizeCharge(
  deps: InitiateCardPaymentDeps,
  payment: PaymentRecord,
  outcome: ChargeOutcome
): ResultAsync<CardPaymentOutcome, DomainError> {
  return fromPromise(
    runSettlement(deps.db, (tx: SettlementTx) =>
      outcome.status === 'approved'
        ? deps.stores.markPaymentChargedWithinTx(tx, payment.id, {
            helcimTransactionId: outcome.transactionId,
            ...(outcome.cardType === undefined ? {} : { cardType: outcome.cardType }),
            ...(outcome.cardLastFour === undefined ? {} : { cardLastFour: outcome.cardLastFour }),
          })
        : deps.stores.markPaymentFailedWithinTx(tx, payment.id, CARD_DECLINED_ERROR_CODE, 'pending')
    ),
    (cause) => unavailableError('payment finalize failed', cause)
  ).andThen((transitioned) => {
    if (transitioned) {
      return okAsync<CardPaymentOutcome, DomainError>({
        paymentId: payment.id,
        status: outcome.status === 'approved' ? 'awaiting_webhook' : 'failed',
        amountNanoUsd: payment.amountNanoUsd,
      });
    }
    // 0 rows: a concurrent retry finalized first — read and replay its state.
    return deps.stores.readPayment(deps.db, payment.id).andThen((row) => {
      if (row === null) {
        throw new Error('payment pre-claim row vanished during finalize');
      }
      return okAsync(cardPaymentOutcomeOf(row));
    });
  });
}

/**
 * Pattern D, whole: the durable `payments` pre-claim (plus the delayed verify
 * job, same transaction) commits BEFORE the card charge; the charge carries
 * the pre-claim id as its provider idempotency key; finalize records the
 * approval (`awaiting_webhook`) or decline. A crash at any point leaves the
 * pre-claim row as the reconciliation anchor for the webhook and the verify
 * job — never a second capture.
 */
export function initiateCardPayment(
  deps: InitiateCardPaymentDeps,
  args: InitiateCardPaymentArgs
): ResultAsync<Idempotent<CardPaymentOutcome>, DomainError> {
  const invalid = validateChargeAmount(args.amountNanoUsd);
  if (invalid !== null) {
    return errAsync<Idempotent<CardPaymentOutcome>, DomainError>(invalid);
  }
  return byExternalPreClaim<ChargeClaim, ExternalCharge, CardPaymentOutcome, DomainError>({
    preClaim: () => preClaimPayment(deps, args),
    external: (claim) => chargeExternal(deps, args, claim),
    finalize: (claim, external) =>
      external.kind === 'replay'
        ? okAsync(cardPaymentOutcomeOf(claim.payment))
        : finalizeCharge(deps, claim.payment, external.outcome),
  });
}

export interface CreditPaymentArgs {
  readonly paymentId: string;
  readonly userId: string;
  readonly amountNanoUsd: bigint;
}

/**
 * The webhook-finalization credit: a zero-sum deposit pair (user purchased
 * wallet ↔ payments-in house account). Exactly-once rides on the caller's
 * completed-claim transition in the SAME transaction; the unique leg keys are
 * the independent DB-backed second guard.
 */
export async function creditPaymentWithinTx(
  stores: BillingStores,
  tx: SettlementTx,
  args: CreditPaymentArgs
): Promise<void> {
  const walletRef = await stores.insertWalletIfAbsentWithinTx(tx, args.userId, 'purchased');
  const wallet = await stores.lockWalletWithinTx(tx, walletRef.id);
  const balanceAfter = wallet.balanceNanoUsd + args.amountNanoUsd;
  const transactionId = crypto.randomUUID();
  await stores.insertLedgerLegsWithinTx(tx, [
    {
      transactionId,
      kind: 'deposit',
      amountNanoUsd: args.amountNanoUsd,
      balanceAfterNanoUsd: balanceAfter,
      walletId: wallet.id,
      paymentId: args.paymentId,
      idempotencyKey: `deposit:${args.paymentId}:user`,
    },
    {
      transactionId,
      kind: 'deposit',
      amountNanoUsd: -args.amountNanoUsd,
      houseAccount: 'payments-in',
      paymentId: args.paymentId,
      idempotencyKey: `deposit:${args.paymentId}:house`,
    },
  ]);
  await stores.updateWalletBalanceWithinTx(tx, wallet.id, balanceAfter, wallet.ledgerSeq + 1n);
}

/**
 * Pattern C enqueue inside the pre-claim transaction: delayed to the webhook
 * threshold, deduped per payment so a retried pre-claim never double-enqueues.
 */
export function enqueuePaymentVerifyWithinTx(
  tx: DbWriter,
  registry: JobRegistry,
  args: { readonly paymentId: string; readonly now: Date }
): Promise<EnqueueJobResult> {
  return enqueueWithinTx(tx, registry, {
    type: PAYMENT_VERIFY_JOB_TYPE,
    payload: { paymentId: args.paymentId },
    dedupeKey: `payment.verify:${args.paymentId}`,
    scheduledAt: new Date(args.now.getTime() + PAYMENT_VERIFY_DELAY_SECONDS * 1000),
  });
}
