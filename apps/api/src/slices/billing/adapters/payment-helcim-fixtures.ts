/**
 * Sandbox-shaped Helcim HTTP fixtures for the parity suite. No real sandbox
 * calls happen in tests — CI exercises the live sandbox only in the e2e job.
 *
 * Provenance:
 * - Purchase responses (approved / declined / errors-map) mirror the shapes
 *   the legacy client parses and its tests encode (verified against the
 *   legacy Helcim integration).
 * - The card-transaction status response is SYNTHETIC: the legacy code never
 *   queries it, so the shape is taken from Helcim's v2 API conventions and
 *   must be confirmed before `payment.verify.v1` ships against production.
 */

export const HELCIM_PURCHASE_APPROVED = {
  transactionId: 12_345,
  approvalCode: 'ABC123',
  responseMessage: 'APPROVED',
  cardNumber: '************1234',
  cardType: 'Visa',
} as const;

export const HELCIM_PURCHASE_DECLINED = {
  responseMessage: 'Insufficient funds',
} as const;

export const HELCIM_PURCHASE_ERRORS_MAP = {
  errors: {
    ERR_INVALID_REQUEST: [
      { code: 'ERR_INVALID_REQUEST', message: 'Invalid card token' },
      { code: 'ERR_INVALID_REQUEST', message: 'Invalid amount' },
    ],
  },
} as const;

/** SYNTHETIC shape — see the provenance note above. */
export const HELCIM_TRANSACTION_STATUS_APPROVED = {
  transactionId: 12_345,
  status: 'APPROVED',
} as const;

/** SYNTHETIC shape — see the provenance note above. */
export const HELCIM_TRANSACTION_STATUS_DECLINED = {
  transactionId: 12_345,
  status: 'DECLINED',
} as const;

export interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | undefined;
}

type QueuedResponse =
  | { readonly kind: 'response'; readonly status: number; readonly body: string }
  | { readonly kind: 'network-error' }
  | { readonly kind: 'hang' };

export interface FixtureFetch {
  readonly fetchImpl: typeof fetch;
  enqueueJson(status: number, body: unknown): void;
  enqueueRaw(status: number, body: string): void;
  /** The next call rejects like a transport failure (retry-path fixtures). */
  enqueueNetworkError(): void;
  /** The next call never settles (per-attempt timeout fixtures). */
  enqueueHang(): void;
  requests(): readonly RecordedRequest[];
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * A recording fetch stub that replays queued fixture responses, so adapter
 * tests can assert the exact outgoing request (idempotency-key forwarding)
 * without any network.
 */
export function createFixtureFetch(): FixtureFetch {
  const recorded: RecordedRequest[] = [];
  const queue: QueuedResponse[] = [];

  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    for (const [key, value] of new Headers(init?.headers)) {
      headers[key] = value;
    }
    recorded.push({
      url: urlOf(input),
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : undefined,
    });

    const next = queue.shift();
    if (next === undefined) {
      return Promise.reject(new Error('fixture fetch: no response queued'));
    }
    if (next.kind === 'network-error') {
      return Promise.reject(new Error('fixture fetch: network error'));
    }
    if (next.kind === 'hang') {
      return new Promise<Response>(() => {
        // Never settles by design.
      });
    }
    return Promise.resolve(
      new Response(next.body, {
        status: next.status,
        headers: { 'content-type': 'application/json' },
      })
    );
  }) as typeof fetch;

  return {
    fetchImpl,
    enqueueJson(status: number, body: unknown): void {
      queue.push({ kind: 'response', status, body: JSON.stringify(body) });
    },
    enqueueRaw(status: number, body: string): void {
      queue.push({ kind: 'response', status, body });
    },
    enqueueNetworkError(): void {
      queue.push({ kind: 'network-error' });
    },
    enqueueHang(): void {
      queue.push({ kind: 'hang' });
    },
    requests(): readonly RecordedRequest[] {
      return [...recorded];
    },
  };
}
