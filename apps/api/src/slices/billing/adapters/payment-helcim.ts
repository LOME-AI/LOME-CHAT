import { z } from 'zod';
import { errAsync, fromPromise, okAsync } from '../../../lib/result/index.js';
import { notFoundError, unavailableError, validationError } from '../../../lib/errors/index.js';
import { retryWithTimeoutPolicy } from '../../../lib/resilience/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { NanoUSD } from '@hushbox/shared';
import type {
  CaptureLookup,
  ChargeOutcome,
  ChargeRequest,
  ChargeStatus,
  PaymentProvider,
} from '../ports/index.js';

const DEFAULT_BASE_URL = 'https://api.helcim.com/v2';
const NANO_PER_USD = 1_000_000_000n;
const NANO_PER_CENT = 10_000_000n;

export interface HelcimNetworkOptions {
  readonly maxRetries: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly timeoutMs: number;
}

/**
 * Retrying the purchase POST is safe only because the idempotency key is
 * forwarded on every attempt — Helcim replays the original transaction for a
 * reused key instead of charging twice. The status GET is read-only.
 */
const DEFAULT_NETWORK: HelcimNetworkOptions = {
  maxRetries: 2,
  initialDelayMs: 100,
  maxDelayMs: 1000,
  timeoutMs: 30_000,
};

export interface HelcimPaymentProviderConfig {
  readonly apiToken: string;
  /** Helcim v2 API root; sandbox and production share it (only the token differs). */
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly network?: Partial<HelcimNetworkOptions>;
}

interface HttpJson {
  readonly ok: boolean;
  readonly status: number;
  readonly data: unknown;
}

const helcimErrorDetailSchema = z.object({ message: z.string() });

const purchaseResponseSchema = z.object({
  transactionId: z.union([z.string(), z.number()]).optional(),
  approvalCode: z.string().optional(),
  responseMessage: z.string().optional(),
  cardNumber: z.string().optional(),
  cardType: z.string().optional(),
  errors: z.record(z.string(), z.array(helcimErrorDetailSchema)).optional(),
});

const transactionStatusSchema = z.object({
  transactionId: z.union([z.string(), z.number()]),
  status: z.string(),
});

/**
 * The card-transactions search response (`?invoiceNumber=`). SYNTHETIC shape —
 * the legacy client never called this endpoint; taken from Helcim v2
 * conventions and must be confirmed against the sandbox before it ships.
 */
const cardTransactionListSchema = z.array(
  z.object({
    transactionId: z.union([z.string(), z.number()]),
    status: z.string(),
  })
);

/**
 * Exact bigint → decimal-dollar string; no float math touches the money
 * value. The provider's JSON boundary wants a number — card amounts have
 * cent precision (enforced as a charge precondition), exactly representable
 * in a double, so the final `parseFloat` of this string cannot drift.
 */
export function formatNanoUsdAsDollars(amount: NanoUSD): string {
  const whole = amount / NANO_PER_USD;
  const fraction = (amount % NANO_PER_USD).toString(10).padStart(9, '0');
  const trimmed = fraction.replace(/0+$/, '');
  return trimmed === '' ? whole.toString(10) : `${whole.toString(10)}.${trimmed}`;
}

function declineReasonFrom(data: z.infer<typeof purchaseResponseSchema>): string {
  if (data.responseMessage !== undefined && data.responseMessage !== '') {
    return data.responseMessage;
  }
  if (data.errors !== undefined) {
    const joined = Object.values(data.errors)
      .flat()
      .map((detail) => detail.message)
      .join(', ');
    if (joined !== '') return joined;
  }
  return 'Payment declined';
}

/**
 * The real Helcim adapter. Helcim's idempotency mechanism is the
 * `idempotency-key` request header on the purchase call: a reused key
 * replays the original transaction instead of charging again. The header is
 * set from the caller-supplied key on every charge, unconditionally.
 *
 * Error values never carry the api token: failures are mapped to fixed
 * operator-safe messages with the original cause attached, and the token
 * travels only in the request header.
 */
export function createHelcimPaymentProvider(config: HelcimPaymentProviderConfig): PaymentProvider {
  const apiToken = config.apiToken;
  if (apiToken.trim().length === 0) {
    throw new Error('Helcim API token is not configured');
  }
  if (apiToken.length < 10) {
    throw new Error('Helcim API token appears invalid (too short)');
  }

  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const fetchImpl = config.fetchImpl ?? fetch;
  const runner = retryWithTimeoutPolicy({ ...DEFAULT_NETWORK, ...config.network });

  function fetchJson(url: string, init: RequestInit): ResultAsync<HttpJson, DomainError> {
    return runner
      .run(async (signal) => fetchImpl(url, { ...init, signal }))
      .andThen((response) =>
        fromPromise(response.json(), () =>
          unavailableError(
            `payment provider returned a non-JSON response (HTTP ${String(response.status)})`
          )
        ).map((data) => ({ ok: response.ok, status: response.status, data }))
      );
  }

  return {
    isMock: false,

    charge(request: ChargeRequest): ResultAsync<ChargeOutcome, DomainError> {
      if (request.amount <= 0n) {
        return errAsync(validationError('charge amount must be positive'));
      }
      if (request.amount % NANO_PER_CENT !== 0n) {
        return errAsync(validationError('charge amount must be whole cents'));
      }

      const body = JSON.stringify({
        amount: Number.parseFloat(formatNanoUsdAsDollars(request.amount)),
        currency: 'USD',
        ipAddress: request.ipAddress,
        customerCode: request.customerCode,
        // Submitted so an orphaned capture is recoverable via the
        // card-transactions search (findCaptureByReference).
        invoiceNumber: request.reference,
        cardData: { cardToken: request.cardToken },
      });

      return fetchJson(`${baseUrl}/payment/purchase`, {
        method: 'POST',
        headers: {
          'api-token': apiToken,
          'Content-Type': 'application/json',
          accept: 'application/json',
          'idempotency-key': request.idempotencyKey,
        },
        body,
      }).andThen(({ ok, data }) => {
        const parsed = purchaseResponseSchema.safeParse(data);
        if (!parsed.success) {
          return errAsync<ChargeOutcome, DomainError>(
            unavailableError('payment provider returned an unrecognized purchase response')
          );
        }

        if (ok && parsed.data.approvalCode !== undefined) {
          if (parsed.data.transactionId === undefined) {
            return errAsync<ChargeOutcome, DomainError>(
              unavailableError('payment provider approved without a transaction id')
            );
          }
          return okAsync<ChargeOutcome, DomainError>({
            status: 'approved',
            transactionId: String(parsed.data.transactionId),
            ...(parsed.data.cardType === undefined ? {} : { cardType: parsed.data.cardType }),
            ...(parsed.data.cardNumber === undefined
              ? {}
              : { cardLastFour: parsed.data.cardNumber.slice(-4) }),
          });
        }

        // Any non-approved response — including HTTP 5xx with a parseable
        // JSON body — maps to a terminal decline, mirroring the legacy
        // contract the behavioral spec encodes. Real Helcim 5xx semantics
        // are unverified (founder verification pending); if a 5xx can mean
        // "charged but errored", the payment.verify.v1 reconcile job is what
        // surfaces the truth against the durable pre-claim.
        return okAsync<ChargeOutcome, DomainError>({
          status: 'declined',
          declineReason: declineReasonFrom(parsed.data),
        });
      });
    },

    getChargeStatus(transactionId: string): ResultAsync<ChargeStatus, DomainError> {
      return fetchJson(`${baseUrl}/card-transactions/${encodeURIComponent(transactionId)}`, {
        method: 'GET',
        headers: { 'api-token': apiToken, accept: 'application/json' },
      }).andThen(({ ok, status, data }) => {
        if (status === 404) {
          return errAsync<ChargeStatus, DomainError>(
            notFoundError('payment provider has no such transaction')
          );
        }
        if (!ok) {
          return errAsync<ChargeStatus, DomainError>(
            unavailableError(`payment provider status query failed (HTTP ${String(status)})`)
          );
        }

        const parsed = transactionStatusSchema.safeParse(data);
        if (!parsed.success) {
          return errAsync<ChargeStatus, DomainError>(
            unavailableError('payment provider returned an unrecognized status response')
          );
        }

        const providerStatus = parsed.data.status.toUpperCase();
        if (providerStatus === 'APPROVED') {
          return okAsync<ChargeStatus, DomainError>({
            status: 'approved',
            transactionId: String(parsed.data.transactionId),
          });
        }
        if (providerStatus === 'DECLINED') {
          return okAsync<ChargeStatus, DomainError>({
            status: 'declined',
            transactionId: String(parsed.data.transactionId),
          });
        }
        return errAsync<ChargeStatus, DomainError>(
          unavailableError('payment provider returned an unrecognized transaction status')
        );
      });
    },

    findCaptureByReference(reference: string): ResultAsync<CaptureLookup, DomainError> {
      return fetchJson(
        `${baseUrl}/card-transactions?invoiceNumber=${encodeURIComponent(reference)}`,
        { method: 'GET', headers: { 'api-token': apiToken, accept: 'application/json' } }
      ).andThen(({ ok, status, data }) => {
        if (!ok) {
          return errAsync<CaptureLookup, DomainError>(
            unavailableError(`payment provider reference lookup failed (HTTP ${String(status)})`)
          );
        }
        const parsed = cardTransactionListSchema.safeParse(data);
        if (!parsed.success) {
          return errAsync<CaptureLookup, DomainError>(
            unavailableError('payment provider returned an unrecognized card-transactions response')
          );
        }
        // A unique reference matches at most one charge; take the first.
        const first = parsed.data[0];
        if (first === undefined) {
          return okAsync<CaptureLookup, DomainError>({ kind: 'not-found' });
        }
        const captureStatus = first.status.toUpperCase();
        if (captureStatus !== 'APPROVED' && captureStatus !== 'DECLINED') {
          return errAsync<CaptureLookup, DomainError>(
            unavailableError('payment provider returned an unrecognized capture status')
          );
        }
        return okAsync<CaptureLookup, DomainError>({
          kind: 'found',
          capture: {
            transactionId: String(first.transactionId),
            status: captureStatus === 'APPROVED' ? 'approved' : 'declined',
          },
        });
      });
    },
  };
}
