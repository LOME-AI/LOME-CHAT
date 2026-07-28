import { ResultAsync, okAsync } from '../../../lib/result/index.js';
import { selectNotifyRecipients } from './notify-decision.js';
import type { NotificationCategory } from '@hushbox/shared';
import type { DomainError } from '../../../lib/errors/index.js';
import type { Telemetry } from '../../../lib/telemetry/index.js';
import type {
  DeviceTokenStore,
  MembershipReader,
  NotificationPreferencesStore,
  PushDelivery,
  PushDeviceRef,
  PushMessage,
  PushSender,
} from '../ports/index.js';

const NOTHING_DELIVERED: PushDelivery = { successCount: 0, failureCount: 0 };

export interface NotifyEventDeps {
  readonly membership: MembershipReader;
  readonly preferences: Pick<NotificationPreferencesStore, 'readForUsers'>;
  readonly deviceTokens: Pick<
    DeviceTokenStore,
    'listTokensForUsers' | 'deleteByToken' | 'touchLastSeen'
  >;
  readonly push: PushSender;
  readonly logger: Telemetry;
  /** Injected clock for the quiet-hours evaluation; defaults to wall time. */
  readonly now?: () => Date;
}

export interface NotifyEventInput {
  readonly category: NotificationCategory;
  readonly conversationId: string;
  /** The user who caused the event; the decision function drops them per category. */
  readonly actorUserId: string | null;
  /**
   * When present, narrows candidates to these users (still filtered by the
   * decision function) — e.g. a membership event targets the added member.
   * Absent means every active member is a candidate.
   */
  readonly recipientUserIds?: readonly string[];
  /** Users present at fire time (caller's snapshot); suppressed downstream. */
  readonly presentUserIds: readonly string[];
}

/**
 * Best-effort, channel-blind notification for one conversation event. Reads
 * the active members, narrows to the target set, applies the single decision
 * function (prefs, quiet hours, mute, presence, actor), fans out to the
 * survivors' devices, and prunes tokens the sender reports dead. The wire
 * payload is generic (`category` + `conversationId`) and is the only thing
 * sent: each transport looks the notification's words up from the category, so
 * this layer never handles text. The composite sender derives the alias. A failure
 * anywhere is logged with its code and returned as a Result — the caller
 * fires-and-forgets; nothing here can crash a request.
 */
export function notifyEvent(
  deps: NotifyEventDeps,
  input: NotifyEventInput
): ResultAsync<PushDelivery, DomainError> {
  const now = (deps.now ?? (() => new Date()))();
  return resolveRecipients(deps, input, now)
    .andThen((recipients) =>
      recipients.length === 0
        ? okAsync<PushDelivery, DomainError>(NOTHING_DELIVERED)
        : deliverToRecipients(deps, input, recipients)
    )
    .mapErr((error) => {
      deps.logger.warn('push.delivery.degraded', {
        errorCode: error.code,
        conversationId: input.conversationId,
      });
      return error;
    });
}

/** Reads members, narrows to the target set, and applies the decision function. */
function resolveRecipients(
  deps: Pick<NotifyEventDeps, 'membership' | 'preferences'>,
  input: NotifyEventInput,
  now: Date
): ResultAsync<readonly string[], DomainError> {
  return deps.membership.listActiveUserMembers(input.conversationId).andThen((members) => {
    const targeted = input.recipientUserIds;
    const candidates =
      targeted === undefined
        ? members
        : members.filter((member) => targeted.includes(member.userId));
    return deps.preferences
      .readForUsers(candidates.map((member) => member.userId))
      .map((prefsByUser) =>
        selectNotifyRecipients({
          members: candidates,
          category: input.category,
          prefsByUser,
          presentUserIds: input.presentUserIds,
          actorUserId: input.actorUserId,
          now,
        })
      );
  });
}

/** Fans the generic payload out to the survivors' devices and prunes dead ones. */
function deliverToRecipients(
  deps: Pick<NotifyEventDeps, 'deviceTokens' | 'push'>,
  input: NotifyEventInput,
  recipients: readonly string[]
): ResultAsync<PushDelivery, DomainError> {
  return deps.deviceTokens.listTokensForUsers(recipients).andThen((tokens) => {
    if (tokens.length === 0) {
      return okAsync<PushDelivery, DomainError>(NOTHING_DELIVERED);
    }
    const message: PushMessage = {
      recipients: tokens,
      payload: { category: input.category, conversationId: input.conversationId },
    };
    return deps.push
      .send(message)
      .andThen((delivery) => pruneDeadTokens(deps, delivery))
      .andThen((delivery) => touchDeliveredTokens(deps, delivery));
  });
}

/**
 * Refreshes `lastSeenAt` on every target the push service accepted. A device
 * that receives notifications is alive, and `lastSeenAt` is the only signal
 * the retention delete reads — without this touch an actively-notified device
 * that never re-registers would be deleted as stale.
 */
function touchDeliveredTokens(
  deps: Pick<NotifyEventDeps, 'deviceTokens'>,
  delivery: PushDelivery
): ResultAsync<PushDelivery, DomainError> {
  const delivered: readonly PushDeviceRef[] = delivery.deliveredTokens ?? [];
  if (delivered.length === 0) {
    return okAsync(delivery);
  }
  return deps.deviceTokens.touchLastSeen(delivered).map(() => delivery);
}

/**
 * Prunes every target the sender reported permanently gone, each with the
 * user-scoped `deleteByToken`. Without this, `device_tokens` grows
 * monotonically with uninstalled devices and revoked subscriptions.
 */
function pruneDeadTokens(
  deps: Pick<NotifyEventDeps, 'deviceTokens'>,
  delivery: PushDelivery
): ResultAsync<PushDelivery, DomainError> {
  const dead: readonly PushDeviceRef[] = delivery.deadTokens ?? [];
  if (dead.length === 0) {
    return okAsync(delivery);
  }
  return ResultAsync.combine(
    dead.map((ref) => deps.deviceTokens.deleteByToken(ref.userId, ref.token))
  ).map(() => delivery);
}
