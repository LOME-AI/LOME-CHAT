import { z } from 'zod';
import { recordServiceEvidence, SERVICE_NAMES } from '@hushbox/db';
import { errAsync, fromPromise } from '../../../lib/result/index.js';
import { unavailableError, validationError } from '../../../lib/errors/index.js';
import { timeoutPolicy } from '../../../lib/resilience/index.js';
import { EMAIL_BATCH_MAX } from '../ports/index.js';
import type { Database } from '@hushbox/db';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type {
  BatchEmailSender,
  BatchSendOptions,
  BatchSendResult,
  EmailMessage,
} from '../ports/index.js';

const RESEND_API_URL = 'https://api.resend.com/emails';
const RESEND_BATCH_API_URL = 'https://api.resend.com/emails/batch';
const DEFAULT_FROM = 'HushBox <noreply@mail.hushbox.ai>';
// Timeout only, no retry: a single send carries no idempotency key, so a
// blind retry could deliver the same email twice. Email is best-effort by
// doctrine — the caller logs the failure and moves on. Batch sends DO carry a
// caller-supplied Idempotency-Key, but the retry decision stays with the
// caller (the dispatch job's own attempt loop), never this adapter.
const DEFAULT_TIMEOUT_MS = 10_000;

const sendResponseSchema = z.object({ id: z.string() });
const batchResponseSchema = z.object({ data: z.array(z.object({ id: z.string() })) });

export interface ResendEmailSenderConfig {
  readonly apiKey: string;
  /** Evidence writes go through `recordServiceEvidence` (CI-only inside). */
  readonly db: Database;
  readonly isCI: boolean;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

/** One wire-shaped Resend email object (shared by single and batch sends). */
function serializeMessage(message: EmailMessage): Record<string, unknown> {
  return {
    from: message.from ?? DEFAULT_FROM,
    to: message.to,
    subject: message.subject,
    html: message.html,
    ...(message.text === undefined ? {} : { text: message.text }),
    ...(message.headers === undefined ? {} : { headers: message.headers }),
  };
}

/**
 * The real Resend adapter — plain HTTP fetch against the Resend API (no npm
 * SDK, deliberately, matching the legacy integration). After a successful
 * send it records a `resend` service-evidence row (a no-op outside CI), so
 * CI's `verify:evidence` step can prove the real seam was exercised.
 *
 * Error values never carry the api key, recipient, or message content:
 * failures map to fixed operator-safe messages with the cause attached.
 */
export function createResendEmailSender(config: ResendEmailSenderConfig): BatchEmailSender {
  if (config.apiKey.trim().length === 0) {
    throw new Error('Resend API key is not configured');
  }

  const fetchImpl = config.fetchImpl ?? fetch;
  const runner = timeoutPolicy({ timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS });

  function post(
    url: string,
    body: string,
    extraHeaders: Record<string, string>
  ): ResultAsync<unknown, DomainError> {
    return runner
      .run(async (signal) =>
        fetchImpl(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            'Content-Type': 'application/json',
            ...extraHeaders,
          },
          body,
          signal,
        })
      )
      .andThen((response) => {
        if (!response.ok) {
          return errAsync<unknown, DomainError>(
            unavailableError(`email provider rejected the send (HTTP ${String(response.status)})`)
          );
        }
        return fromPromise(response.json(), (cause) =>
          unavailableError('email provider returned a non-JSON response', cause)
        );
      });
  }

  function recordEvidence(messageId: string | undefined): ResultAsync<void, DomainError> {
    return fromPromise(
      recordServiceEvidence(
        config.db,
        config.isCI,
        SERVICE_NAMES.RESEND,
        messageId === undefined ? undefined : { messageId }
      ),
      (cause) => unavailableError('service-evidence write failed', cause)
    ).map((): void => undefined);
  }

  return {
    send(message: EmailMessage): ResultAsync<void, DomainError> {
      return post(RESEND_API_URL, JSON.stringify(serializeMessage(message)), {}).andThen((data) => {
        const parsed = sendResponseSchema.safeParse(data);
        return recordEvidence(parsed.success ? parsed.data.id : undefined);
      });
    },

    sendBatch(
      messages: readonly EmailMessage[],
      options: BatchSendOptions
    ): ResultAsync<BatchSendResult, DomainError> {
      if (messages.length > EMAIL_BATCH_MAX) {
        return errAsync(
          validationError(`email batch exceeds the provider cap of ${String(EMAIL_BATCH_MAX)}`)
        );
      }
      return post(
        RESEND_BATCH_API_URL,
        JSON.stringify(messages.map((message) => serializeMessage(message))),
        {
          'Idempotency-Key': options.idempotencyKey,
        }
      ).andThen((data) => {
        const parsed = batchResponseSchema.safeParse(data);
        // Index-matching is the whole contract: callers map ids back onto the
        // submitted batch positionally, so a count mismatch is unusable.
        if (!parsed.success || parsed.data.data.length !== messages.length) {
          return errAsync<BatchSendResult, DomainError>(
            unavailableError('email provider batch response did not match the batch')
          );
        }
        const ids = parsed.data.data.map((item) => item.id);
        return recordEvidence(ids[0]).map((): BatchSendResult => ({ ids }));
      });
    },
  };
}
