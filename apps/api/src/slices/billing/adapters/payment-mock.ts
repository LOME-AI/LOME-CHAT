import { signHmacSha256Webhook } from '@hushbox/crypto';
import { errAsync, okAsync } from '../../../lib/result/index.js';
import { notFoundError, validationError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type {
  CaptureLookup,
  CaptureRecord,
  ChargeOutcome,
  ChargeRequest,
  ChargeStatus,
  PaymentProvider,
} from '../ports/index.js';

const DEFAULT_WEBHOOK_DELAY_MS = 1000;
const NANO_PER_CENT = 10_000_000n;

export interface MockPaymentProviderConfig {
  /** Where approved charges deliver their signed `cardTransaction` webhook. */
  readonly webhookUrl: string;
  /** HMAC secret (standard base64) the mock signs webhooks with. */
  readonly webhookVerifier: string;
  readonly webhookDelayMs?: number;
  readonly fetchImpl?: typeof fetch;
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
  }

  function scheduleWebhook(transactionId: string): void {
    const delivery = (async (): Promise<void> => {
      try {
        await deliverWebhook(transactionId);
      } catch (error) {
        deliveryFailures.push(error);
      }
    })();
    pendingDeliveries.add(delivery);
  }

  return {
    isMock: true,

    charge(request: ChargeRequest): ResultAsync<ChargeOutcome, DomainError> {
      if (request.amount <= 0n) {
        return errAsync(validationError('charge amount must be positive'));
      }
      if (request.amount % NANO_PER_CENT !== 0n) {
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
