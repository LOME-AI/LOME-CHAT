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
      // Reports every target as delivered, so the last-seen refresh the real
      // transports drive is exercised in dev/CI too. `deadTokens` is present
      // and empty because both real transports always return it — dev and CI
      // must see the same delivery shape production does.
      return okAsync({
        successCount: message.recipients.length,
        failureCount: 0,
        deliveredTokens: message.recipients.map((recipient) => ({
          userId: recipient.userId,
          token: recipient.platform === 'web' ? recipient.endpoint : recipient.token,
        })),
        deadTokens: [],
      });
    },

    getSentMessages(): readonly PushMessage[] {
      return [...sent];
    },

    clearSentMessages(): void {
      sent.length = 0;
    },
  };
}
