import type { ResultAsync } from '../../../lib/result/index.js';
import type { DomainError } from '../../../lib/errors/index.js';

export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  readonly text?: string;
  readonly from?: string;
  /** Custom SMTP headers passed through to the provider per-email (e.g. List-Unsubscribe). */
  readonly headers?: Record<string, string>;
}

/**
 * The EmailSender port (ARCHITECTURE.md infra edge). Best-effort by doctrine:
 * callers log a failed Result with its error code and never let it crash the
 * request. Implementations must keep recipient addresses and message content
 * out of error messages — errors carry codes and operator-safe text only.
 */
export interface EmailSender {
  send(message: EmailMessage): ResultAsync<void, DomainError>;
}

/** Resend's hard per-call cap on `/emails/batch`; callers slice their batches. */
export const EMAIL_BATCH_MAX = 100;

/** Per-item provider message ids, index-matched to the submitted batch. */
export interface BatchSendResult {
  readonly ids: readonly string[];
}

export interface BatchSendOptions {
  /**
   * Forwarded as the provider `Idempotency-Key` header: an identical replay
   * (same key, same batch) delivers at most once and returns the original
   * index-matched ids, which is what makes crash-retry re-sends safe.
   */
  readonly idempotencyKey: string;
}

/**
 * The batch extension of the EmailSender port. A separate interface rather
 * than a new required method on `EmailSender` so the many existing
 * single-send test doubles stay valid; both shipped adapters implement it.
 */
export interface BatchEmailSender extends EmailSender {
  sendBatch(
    messages: readonly EmailMessage[],
    options: BatchSendOptions
  ): ResultAsync<BatchSendResult, DomainError>;
}
