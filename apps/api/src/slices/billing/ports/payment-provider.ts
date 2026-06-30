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

/**
 * The billing slice's payment seam (card charges only; refunds are not part
 * of the legacy integration and are deliberately absent). `getChargeStatus`
 * serves the Pattern-D reconcile path (`payment.verify.v1`): it queries the
 * provider for a transaction the webhook never confirmed.
 */
export interface PaymentProvider {
  readonly isMock: boolean;
  charge(request: ChargeRequest): ResultAsync<ChargeOutcome, DomainError>;
  getChargeStatus(transactionId: string): ResultAsync<ChargeStatus, DomainError>;
}
