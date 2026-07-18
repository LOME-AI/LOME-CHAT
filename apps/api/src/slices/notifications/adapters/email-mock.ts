import { validationError } from '../../../lib/errors/index.js';
import { errAsync, okAsync } from '../../../lib/result/index.js';
import { EMAIL_BATCH_MAX } from '../ports/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type {
  BatchEmailSender,
  BatchSendOptions,
  BatchSendResult,
  EmailMessage,
} from '../ports/index.js';

export interface RecordedEmailBatch {
  readonly messages: readonly EmailMessage[];
  readonly idempotencyKey: string;
}

export interface MockEmailSender extends BatchEmailSender {
  getSentMessages(): readonly EmailMessage[];
  getSentBatches(): readonly RecordedEmailBatch[];
  clearSentMessages(): void;
}

/**
 * In-process fake for local dev and CI (no real email leaves either mode;
 * the factory selects it there) and the test double for domain code that
 * composes email sends.
 */
export function createMockEmailSender(): MockEmailSender {
  const sent: EmailMessage[] = [];
  const batches: RecordedEmailBatch[] = [];
  let idCounter = 0;

  return {
    send(message: EmailMessage): ResultAsync<void, DomainError> {
      sent.push({ ...message });
      return okAsync();
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
      batches.push({ messages: messages.map((message) => ({ ...message })), ...options });
      sent.push(...messages.map((message) => ({ ...message })));
      return okAsync({
        ids: messages.map(() => {
          idCounter += 1;
          return `mock-email-${String(idCounter)}`;
        }),
      });
    },

    getSentMessages(): readonly EmailMessage[] {
      return [...sent];
    },

    getSentBatches(): readonly RecordedEmailBatch[] {
      return [...batches];
    },

    clearSentMessages(): void {
      sent.length = 0;
      batches.length = 0;
    },
  };
}
