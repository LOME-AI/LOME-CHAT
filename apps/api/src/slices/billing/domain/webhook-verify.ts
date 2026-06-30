import { z } from 'zod';
import { fromStandardBase64 } from '@hushbox/shared';
import { verifyHmacSha256Webhook } from '@hushbox/crypto';
import { ResultAsync, errAsync, okAsync } from '../../../lib/result/index.js';
import { isDomainError, unauthorizedError, validationError } from '../../../lib/errors/index.js';
import type { DomainError } from '../../../lib/errors/index.js';

/** Helcim webhook signature headers (`webhook-signature` / `webhook-timestamp` / `webhook-id`). */
export interface WebhookSignatureHeaders {
  readonly signature: string | undefined;
  readonly timestamp: string | undefined;
  readonly webhookId: string | undefined;
}

/**
 * The closed event union consumed by the webhook route (clawback flow). The
 * dispute taxonomy is load-bearing: auto-defense may trigger only on
 * chargeback and reversal; inquiries and retrievals notify but never lock
 * (ARCHITECTURE.md, money & settlement).
 */
export type PaymentWebhookEvent =
  | { readonly type: 'payment.completed'; readonly transactionId: string }
  | { readonly type: 'payment.failed'; readonly transactionId: string }
  | { readonly type: 'dispute.chargeback'; readonly transactionId: string }
  | { readonly type: 'dispute.reversal'; readonly transactionId: string }
  | { readonly type: 'dispute.inquiry'; readonly transactionId: string }
  | { readonly type: 'dispute.retrieval'; readonly transactionId: string }
  | { readonly type: 'unrecognized'; readonly rawType: string };

/**
 * Raw Helcim wire types → domain event types. Only `cardTransaction` is
 * verified against real Helcim traffic (the legacy webhook route and the CI
 * sandbox full-flow e2e). The decline and dispute raw strings are provisional
 * mappings awaiting founder verification against Helcim's dispute webhooks;
 * an unmapped raw type yields `unrecognized`, never a crash.
 */
const RAW_EVENT_TYPE_MAP: ReadonlyMap<
  string,
  Exclude<PaymentWebhookEvent['type'], 'unrecognized'>
> = new Map([
  ['cardTransaction', 'payment.completed'],
  ['declinedCardTransaction', 'payment.failed'],
  ['chargeback', 'dispute.chargeback'],
  ['reversal', 'dispute.reversal'],
  ['inquiry', 'dispute.inquiry'],
  ['retrieval', 'dispute.retrieval'],
]);

const rawEventSchema = z.object({
  type: z.string().optional(),
  id: z.union([z.string(), z.number()]).optional(),
  transactionId: z.union([z.string(), z.number()]).optional(),
});

export interface WebhookVerifier {
  verify(
    rawBody: string,
    headers: WebhookSignatureHeaders
  ): ResultAsync<PaymentWebhookEvent, DomainError>;
}

export interface WebhookVerifierConfig {
  /** The HMAC verifier secret (standard base64). Missing config is a startup defect. */
  readonly verifier: string | undefined;
}

function parseEvent(rawBody: string): PaymentWebhookEvent | DomainError {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return validationError('webhook body is not valid JSON');
  }

  const event = rawEventSchema.safeParse(parsed);
  if (!event.success) {
    return validationError('webhook body has an invalid shape');
  }

  const rawType = event.data.type ?? '';
  const mappedType = RAW_EVENT_TYPE_MAP.get(rawType);
  if (mappedType === undefined) {
    return { type: 'unrecognized', rawType };
  }

  const rawId = event.data.id ?? event.data.transactionId;
  if (rawId === undefined || rawId === '') {
    return validationError('webhook event is missing a transaction id');
  }

  return { type: mappedType, transactionId: String(rawId) };
}

/**
 * Fail-closed Helcim webhook verification: the verifier secret is
 * mandatory at construction (and must decode as standard base64 — a corrupt
 * secret would otherwise survive startup and reject every delivery as a
 * silent 401), every request must carry all three signature headers, and the
 * body is parsed into a domain event only after the HMAC over the raw body
 * verifies. There is no header-presence branch that skips verification.
 *
 * Verification has no freshness window — Helcim signs the timestamp but
 * defines no tolerance, so an identical replayed delivery verifies again.
 * The webhook route's atomic status claim is the sole replay-absorption
 * mechanism; routes consuming this verifier must apply it.
 */
export function createWebhookVerifier(config: WebhookVerifierConfig): WebhookVerifier {
  const verifier = config.verifier;
  if (verifier === undefined || verifier.trim().length === 0) {
    throw new Error('Helcim webhook verifier is not configured');
  }
  try {
    fromStandardBase64(verifier);
  } catch (error) {
    throw new Error('Helcim webhook verifier is not valid standard base64', { cause: error });
  }

  return {
    verify(
      rawBody: string,
      headers: WebhookSignatureHeaders
    ): ResultAsync<PaymentWebhookEvent, DomainError> {
      const { signature, timestamp, webhookId } = headers;
      if (signature === undefined || timestamp === undefined || webhookId === undefined) {
        return errAsync(unauthorizedError('webhook signature headers missing'));
      }

      // fromSafePromise: the crypto primitive catches internally and resolves
      // false on any failure — its promise cannot reject.
      return ResultAsync.fromSafePromise<boolean, DomainError>(
        verifyHmacSha256Webhook({
          secret: verifier,
          payload: rawBody,
          signatureHeader: signature,
          timestamp,
          webhookId,
        })
      ).andThen((isValid) => {
        if (!isValid) {
          return errAsync(unauthorizedError('webhook signature invalid'));
        }
        const eventOrError = parseEvent(rawBody);
        return isDomainError(eventOrError) ? errAsync(eventOrError) : okAsync(eventOrError);
      });
    },
  };
}
