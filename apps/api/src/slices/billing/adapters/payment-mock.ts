import { signHmacSha256Webhook } from '@hushbox/crypto';
import { NANO_USD_PER_CENT } from '@hushbox/shared';
import { errAsync, okAsync } from '../../../lib/result/index.js';
import { notFoundError, validationError } from '../../../lib/errors/index.js';
import { retryPolicy } from '../../../lib/resilience/index.js';
import { createConsoleTelemetry } from '../../../lib/telemetry/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { RetryOptions } from '../../../lib/resilience/index.js';
import type { Telemetry } from '../../../lib/telemetry/index.js';
import type {
  CaptureLookup,
  CaptureRecord,
  ChargeOutcome,
  ChargeRequest,
  ChargeStatus,
  PaymentProvider,
  WebhookDeliveryLifetime,
} from '../ports/index.js';

const DEFAULT_WEBHOOK_DELAY_MS = 1000;

/**
 * Bounded retry for the mock's self-delivered webhook. Under a local host
 * CPU-saturation burst the self-`fetch` to the API's own webhook route can
 * fail with a transient broken-pipe/reset; a few attempts over a few seconds
 * ride that out. Delivery is idempotent at the receiver (byEventId), so
 * re-posting is safe. This is dev/CI mock behaviour only — production uses real
 * Helcim + Hookdeck and never touches this path.
 */
const DEFAULT_WEBHOOK_RETRY: RetryOptions = {
  maxRetries: 5,
  initialDelayMs: 200,
  maxDelayMs: 2000,
};

export interface MockPaymentProviderConfig {
  /** Where approved charges deliver their signed `cardTransaction` webhook. */
  readonly webhookUrl: string;
  /** HMAC secret (standard base64) the mock signs webhooks with. */
  readonly webhookVerifier: string;
  readonly webhookDelayMs?: number;
  readonly fetchImpl?: typeof fetch;
  /** Overrides the bounded self-delivery retry window (tests keep it instant). */
  readonly webhookRetry?: RetryOptions;
  /** Sink for the loud log line on a self-delivery that fails after retries. */
  readonly telemetry?: Telemetry;
  /**
   * The request's execution context. Registering the delayed webhook delivery
   * on it keeps the delivery alive after the charge response returns — without
   * it, workerd abandons the floating promise and the webhook never fires.
   * Absent in unit tests (they drive delivery via `flushWebhooks`).
   */
  readonly executionCtx?: WebhookDeliveryLifetime | undefined;
}

export interface MockPaymentProvider extends PaymentProvider {
  setNextChargeOutcome(outcome: ChargeOutcome): void;
  /**
   * Primes a capture the provider will report for a merchant reference — the
   * orphaned-capture reconcile fixture (a charge captured but never recorded).
   * The capture's transaction id is also made resolvable by `getChargeStatus`.
   */
  setCaptureForReference(reference: string, capture: CaptureRecord): void;
  getChargeRequests(): readonly ChargeRequest[];
  clearChargeRequests(): void;
  /** Awaits every scheduled webhook delivery (test/dev determinism hook). */
  flushWebhooks(): Promise<void>;
  /** Delivery failures are captured here, never thrown — the mock is dev-only. */
  getWebhookDeliveryFailures(): readonly unknown[];
}

function freshApprovedOutcome(): ChargeOutcome {
  return {
    status: 'approved',
    transactionId: `mock-txn-${crypto.randomUUID()}`,
    cardType: 'Visa',
    cardLastFour: '9990',
  };
}

/**
 * In-process fake matching the legacy local-mock contract: approve by
 * default, primeable next outcome, recorded charge requests (the mock's
 * "outgoing request" — the idempotency key is asserted on it), and a signed
 * `cardTransaction` webhook delivered after a delay so the local full
 * payment flow runs without real Helcim.
 */
export function createMockPaymentProvider(config: MockPaymentProviderConfig): MockPaymentProvider {
  if (config.webhookVerifier.trim().length === 0) {
    throw new Error('Mock payment provider webhook verifier is not configured');
  }
  if (config.webhookUrl.trim().length === 0) {
    throw new Error('Mock payment provider webhook url is not configured');
  }

  const delayMs = config.webhookDelayMs ?? DEFAULT_WEBHOOK_DELAY_MS;
  const fetchImpl = config.fetchImpl ?? fetch;
  const telemetry = config.telemetry ?? createConsoleTelemetry();
  const webhookDelivery = retryPolicy(config.webhookRetry ?? DEFAULT_WEBHOOK_RETRY);

  const chargeRequests: ChargeRequest[] = [];
  const knownTransactions = new Map<string, ChargeStatus>();
  const capturesByReference = new Map<string, CaptureRecord>();
  const pendingDeliveries = new Set<Promise<void>>();
  const deliveryFailures: unknown[] = [];
  let nextOutcome: ChargeOutcome | undefined;

  /** A capture is both searchable by reference and resolvable by its txn id. */
  function registerCapture(reference: string, capture: CaptureRecord): void {
    capturesByReference.set(reference, capture);
    knownTransactions.set(capture.transactionId, {
      status: capture.status,
      transactionId: capture.transactionId,
    });
  }

  async function deliverWebhook(transactionId: string): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    // Retry only the sign+POST: a transient burst rejection is ridden out,
    // while a persistent failure is logged loudly (never swallowed) and
    // recorded for test determinism (`getWebhookDeliveryFailures`).
    const delivery = await webhookDelivery.run(async () => {
      const payload = JSON.stringify({ type: 'cardTransaction', id: transactionId });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const webhookId = `mock-webhook-${crypto.randomUUID()}`;
      const signature = await signHmacSha256Webhook({
        secret: config.webhookVerifier,
        payload,
        timestamp,
        webhookId,
      });
      await fetchImpl(config.webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'webhook-signature': signature,
          'webhook-timestamp': timestamp,
          'webhook-id': webhookId,
        },
        body: payload,
      });
    });
    if (delivery.isErr()) {
      telemetry.error('mock payment webhook self-delivery failed after retries', {
        errorCode: 'mock_webhook_delivery_failed',
      });
      deliveryFailures.push(delivery.error);
    }
  }

  function scheduleWebhook(transactionId: string): void {
    // `deliverWebhook` never rejects — the retry runner surfaces failure as an
    // Err it handles inline — so the floating promise is safe to register.
    const delivery = deliverWebhook(transactionId);
    pendingDeliveries.add(delivery);
    // Lifetime-safety: in workerd the request context ends when the charge
    // response returns, so an unregistered delivery is abandoned before its
    // delayed fire. `waitUntil` holds the context open until it completes.
    // `pendingDeliveries` remains the test-determinism hook (`flushWebhooks`).
    config.executionCtx?.waitUntil(delivery);
  }

  return {
    isMock: true,

    charge(request: ChargeRequest): ResultAsync<ChargeOutcome, DomainError> {
      if (request.amount <= 0n) {
        return errAsync(validationError('charge amount must be positive'));
      }
      if (request.amount % NANO_USD_PER_CENT !== 0n) {
        return errAsync(validationError('charge amount must be whole cents'));
      }

      chargeRequests.push({ ...request });

      const outcome = nextOutcome ?? freshApprovedOutcome();
      nextOutcome = undefined;

      if (outcome.status === 'approved') {
        registerCapture(request.reference, {
          transactionId: outcome.transactionId,
          status: 'approved',
        });
        scheduleWebhook(outcome.transactionId);
      }

      return okAsync(outcome);
    },

    getChargeStatus(transactionId: string): ResultAsync<ChargeStatus, DomainError> {
      const known = knownTransactions.get(transactionId);
      if (known === undefined) {
        return errAsync(notFoundError('payment provider has no such transaction'));
      }
      return okAsync(known);
    },

    findCaptureByReference(reference: string): ResultAsync<CaptureLookup, DomainError> {
      const capture = capturesByReference.get(reference);
      return okAsync(capture === undefined ? { kind: 'not-found' } : { kind: 'found', capture });
    },

    setNextChargeOutcome(outcome: ChargeOutcome): void {
      nextOutcome = outcome;
    },

    setCaptureForReference(reference: string, capture: CaptureRecord): void {
      registerCapture(reference, capture);
    },

    getChargeRequests(): readonly ChargeRequest[] {
      return [...chargeRequests];
    },

    clearChargeRequests(): void {
      chargeRequests.length = 0;
    },

    async flushWebhooks(): Promise<void> {
      while (pendingDeliveries.size > 0) {
        const batch = [...pendingDeliveries];
        await Promise.all(batch);
        for (const delivery of batch) {
          pendingDeliveries.delete(delivery);
        }
      }
    },

    getWebhookDeliveryFailures(): readonly unknown[] {
      return [...deliveryFailures];
    },
  };
}
