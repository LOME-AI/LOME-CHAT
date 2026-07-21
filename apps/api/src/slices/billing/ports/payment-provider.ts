import type { NanoUSD } from '@hushbox/shared';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { DomainError } from '../../../lib/errors/index.js';

/**
 * One charge request (Pattern D's external effect). The idempotency key is
 * caller-supplied — the durable `payments` pre-claim id — and is forwarded
 * verbatim to the provider on every charge call, so a retried charge can
 * never capture twice (Helcim replays the original response for a reused
 * `idempotency-key` header).
 */
export interface ChargeRequest {
  readonly idempotencyKey: string;
  /**
   * Merchant reference submitted as the charge's `invoiceNumber` — the only
   * charge-side identifier Helcim's card-transactions search can filter on, so
   * it is the reconcile anchor when a capture lands but the transaction id is
   * lost before it is recorded (see `findCaptureByReference`).
   */
  readonly reference: string;
  readonly amount: NanoUSD;
  /** HelcimPay.js card token; tokens are bound to the customer code. */
  readonly cardToken: string;
  readonly customerCode: string;
  /** Required by Helcim for card-token purchases. */
  readonly ipAddress: string;
}

/** A decline is an expected outcome, not an error-channel value. */
export type ChargeOutcome =
  | {
      readonly status: 'approved';
      readonly transactionId: string;
      readonly cardType?: string;
      readonly cardLastFour?: string;
    }
  | { readonly status: 'declined'; readonly declineReason: string };

export type ChargeStatus =
  | { readonly status: 'approved'; readonly transactionId: string }
  | { readonly status: 'declined'; readonly transactionId: string };

/** A capture the provider holds for a merchant reference. */
export interface CaptureRecord {
  readonly transactionId: string;
  readonly status: 'approved' | 'declined';
}

/**
 * The result of searching the provider by merchant reference: either the
 * capture it holds, or a confirmed absence. Absence is an expected value (the
 * reference genuinely never charged), not an error-channel failure — so a
 * still-`pending` pre-claim can safely expire when nothing is found.
 */
export type CaptureLookup =
  | { readonly kind: 'found'; readonly capture: CaptureRecord }
  | { readonly kind: 'not-found' };

/**
 * The billing slice's payment seam (card charges only; refunds are not part
 * of the legacy integration and are deliberately absent). `getChargeStatus`
 * serves the Pattern-D reconcile path (`payment.verify.v1`): it queries the
 * provider for a transaction the webhook never confirmed.
 */
/**
 * The structural slice of the Worker's `ExecutionContext` a background task
 * needs to outlive the response that scheduled it. The local mock provider
 * self-delivers its confirming webhook after a delay; in workerd the request
 * context ends when the charge response returns, so the delivery must be
 * registered here to actually fire. The real provider never uses it.
 */
export interface WebhookDeliveryLifetime {
  waitUntil(promise: Promise<unknown>): void;
}

export interface PaymentProvider {
  readonly isMock: boolean;
  charge(request: ChargeRequest): ResultAsync<ChargeOutcome, DomainError>;
  getChargeStatus(transactionId: string): ResultAsync<ChargeStatus, DomainError>;
  /**
   * Searches the provider by the charge's merchant `reference` (Helcim
   * `invoiceNumber`). The reconcile path for an orphaned capture: a charge
   * that captured but whose transaction id was never recorded is recoverable
   * only through this reference-keyed lookup.
   */
  findCaptureByReference(reference: string): ResultAsync<CaptureLookup, DomainError>;
}
