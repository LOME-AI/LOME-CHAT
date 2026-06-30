import { ResultAsync, okAsync } from '../../../lib/result/index.js';
import { selectPushRecipients } from './push-recipients.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { Telemetry } from '../../../lib/telemetry/index.js';
import type {
  DeviceTokenStore,
  MembershipReader,
  PresenceReader,
  PushDelivery,
  PushSender,
} from '../ports/index.js';

const NOTHING_DELIVERED: PushDelivery = { successCount: 0, failureCount: 0 };

export interface MessagePushDeps {
  readonly membership: MembershipReader;
  readonly presence: PresenceReader;
  readonly deviceTokens: Pick<DeviceTokenStore, 'listTokensForUsers'>;
  readonly push: PushSender;
  readonly logger: Telemetry;
}

export interface NewMessagePush {
  readonly conversationId: string;
  readonly senderUserId: string;
  /** Caller-chosen copy — message content never reaches a push payload. */
  readonly title: string;
  readonly body: string;
}

/**
 * Best-effort push for a new message, filtered by mute and presence
 * (`selectPushRecipients`). A failure anywhere is logged with its code and
 * returned as a Result value — the caller fires-and-forgets; nothing here
 * can crash a request.
 */
export function sendPushForNewMessage(
  deps: MessagePushDeps,
  input: NewMessagePush
): ResultAsync<PushDelivery, DomainError> {
  return ResultAsync.combine([
    deps.membership.listActiveUserMembers(input.conversationId),
    deps.presence.presence(input.conversationId),
  ])
    .andThen(([members, presentUserIds]) => {
      const recipients = selectPushRecipients({
        members,
        presentUserIds,
        senderUserId: input.senderUserId,
      });
      if (recipients.length === 0) {
        return okAsync<PushDelivery, DomainError>(NOTHING_DELIVERED);
      }
      return deps.deviceTokens.listTokensForUsers(recipients).andThen((tokens) => {
        if (tokens.length === 0) {
          return okAsync<PushDelivery, DomainError>(NOTHING_DELIVERED);
        }
        return deps.push.send({
          tokens,
          title: input.title,
          body: input.body,
          data: { conversationId: input.conversationId },
        });
      });
    })
    .mapErr((error) => {
      deps.logger.warn('push.delivery.degraded', {
        errorCode: error.code,
        conversationId: input.conversationId,
      });
      return error;
    });
}
