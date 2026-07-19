import { okAsync } from '../../../lib/result/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { PushDelivery, PushMessage, PushSender } from '../ports/index.js';

export interface MockPushSender extends PushSender {
  getSentMessages(): readonly PushMessage[];
  clearSentMessages(): void;
}

/**
 * In-process fake for local dev and CI (the factory selects it there) and
 * the test double for the push-dispatch domain logic.
 */
export function createMockPushSender(): MockPushSender {
  const sent: PushMessage[] = [];

  return {
    send(message: PushMessage): ResultAsync<PushDelivery, DomainError> {
      sent.push({ ...message });
      return okAsync({ successCount: message.recipients.length, failureCount: 0 });
    },

    getSentMessages(): readonly PushMessage[] {
      return [...sent];
    },

    clearSentMessages(): void {
      sent.length = 0;
    },
  };
}
