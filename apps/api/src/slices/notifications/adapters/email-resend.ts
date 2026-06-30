import { z } from 'zod';
import { recordServiceEvidence, SERVICE_NAMES } from '@hushbox/db';
import { errAsync, fromPromise } from '../../../lib/result/index.js';
import { unavailableError } from '../../../lib/errors/index.js';
import { timeoutPolicy } from '../../../lib/resilience/index.js';
import type { Database } from '@hushbox/db';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { EmailMessage, EmailSender } from '../ports/index.js';

const RESEND_API_URL = 'https://api.resend.com/emails';
const DEFAULT_FROM = 'HushBox <noreply@mail.hushbox.ai>';
// Timeout only, no retry: Resend exposes idempotency keys but we don't send
// one, so a blind retry could deliver the same email twice. Email is
// best-effort by doctrine — the caller logs the failure and moves on.
const DEFAULT_TIMEOUT_MS = 10_000;

const sendResponseSchema = z.object({ id: z.string() });

export interface ResendEmailSenderConfig {
  readonly apiKey: string;
  /** Evidence writes go through `recordServiceEvidence` (CI-only inside). */
  readonly db: Database;
  readonly isCI: boolean;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
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
export function createResendEmailSender(config: ResendEmailSenderConfig): EmailSender {
  if (config.apiKey.trim().length === 0) {
    throw new Error('Resend API key is not configured');
  }

  const fetchImpl = config.fetchImpl ?? fetch;
  const runner = timeoutPolicy({ timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS });

  return {
    send(message: EmailMessage): ResultAsync<void, DomainError> {
      const body = JSON.stringify({
        from: message.from ?? DEFAULT_FROM,
        to: message.to,
        subject: message.subject,
        html: message.html,
        ...(message.text === undefined ? {} : { text: message.text }),
      });

      return runner
        .run(async (signal) =>
          fetchImpl(RESEND_API_URL, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${config.apiKey}`,
              'Content-Type': 'application/json',
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
        })
        .andThen((data) => {
          const parsed = sendResponseSchema.safeParse(data);
          return fromPromise(
            recordServiceEvidence(
              config.db,
              config.isCI,
              SERVICE_NAMES.RESEND,
              parsed.success ? { messageId: parsed.data.id } : undefined
            ),
            (cause) => unavailableError('service-evidence write failed', cause)
          );
        })
        .map((): void => undefined);
    },
  };
}
