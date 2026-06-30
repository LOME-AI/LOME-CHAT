import { okAsync } from '../../../lib/result/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { EmailMessage, EmailSender } from '../ports/index.js';

export interface MockEmailSender extends EmailSender {
  getSentMessages(): readonly EmailMessage[];
  clearSentMessages(): void;
}

/**
 * In-process fake for local dev and CI (no real email leaves either mode;
 * the factory selects it there) and the test double for domain code that
 * composes email sends.
 */
export function createMockEmailSender(): MockEmailSender {
  const sent: EmailMessage[] = [];

  return {
    send(message: EmailMessage): ResultAsync<void, DomainError> {
      sent.push({ ...message });
      return okAsync();
    },

    getSentMessages(): readonly EmailMessage[] {
      return [...sent];
    },

    clearSentMessages(): void {
      sent.length = 0;
    },
  };
}
