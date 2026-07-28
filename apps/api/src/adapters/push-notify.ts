import {
  createDeviceTokenStore,
  createNotificationPreferencesStore,
  createPushSenderFromEnv,
  notifyEvent,
} from '../slices/notifications/index.js';
import { createConsoleTelemetry } from '../lib/telemetry/index.js';
import { createPushMembershipReader } from '../slices/conversations/adapters/push-membership-reader.js';
import type { Database } from '@hushbox/db';
import type { NotificationCategory } from '@hushbox/shared';
import type { Telemetry } from '../lib/telemetry/index.js';
import type { MembershipReader } from '../slices/notifications/index.js';
import type {
  PushNotifyCompositionDeps,
  PushNotifyFactory,
} from '../slices/conversations/adapters/realtime-room-bindings.js';
import type { NotifyConversationEvent } from '../slices/conversations/index.js';
import type { NotifyNewMessage } from '../slices/chat/index.js';
import type { Bindings } from '../lib/context/app-env.js';

interface PushNotifyInfra {
  readonly env: Bindings;
  readonly db: Database;
  readonly telemetry: Telemetry;
  readonly membership: MembershipReader;
}

/**
 * Binds the notifications-barrel wiring (device-token store, preferences store,
 * push sender) that a conversations or chat adapter may not import, over the
 * caller's membership read, and fixes the event's category. The returned
 * capability never throws and never blocks its caller: every failure is
 * swallowed after `notifyEvent` has logged its own code.
 *
 * Content NEVER reaches the payload — `notifyEvent` sends only the generic
 * category + conversationId pair, and each transport resolves its own fixed
 * per-category copy at the edge (a push notification sits outside the E2E
 * envelope) — and presence rides the CALLER's fire-time snapshot, so members
 * already watching are suppressed without the notifications slice ever
 * querying the room.
 */
function createCategoryPushNotify(
  category: NotificationCategory,
  { env, db, telemetry, membership }: PushNotifyInfra
): NotifyConversationEvent {
  const push = createPushSenderFromEnv(env);
  const deviceTokens = createDeviceTokenStore(db);
  const preferences = createNotificationPreferencesStore(db);
  return async ({ conversationId, actorUserId, recipientUserIds, presentUserIds }) => {
    await notifyEvent(
      { membership, preferences, deviceTokens, push, logger: telemetry },
      {
        category,
        conversationId,
        actorUserId,
        presentUserIds,
        ...(recipientUserIds === undefined ? {} : { recipientUserIds }),
      }
    ).match(
      () => {
        // Delivered (or nothing to deliver) — best-effort, nothing to do.
      },
      () => {
        // notifyEvent already logged the code; swallow the Result so the
        // capability resolves void (best-effort).
      }
    );
  };
}

/**
 * The ConversationRoom's terminal-sink capability: a succeeded run persisted
 * its response, so absent members get the run-completion nudge. Only successful
 * completions reach here — a failed or killed run notifies nothing, because the
 * client's own deadline UX already surfaces that.
 */
export const createRunCompletionPushNotify: PushNotifyFactory = (
  deps: PushNotifyCompositionDeps
) => {
  const notify = createCategoryPushNotify('runCompletion', deps);
  return async ({ conversationId, senderUserId, presentUserIds }) => {
    await notify({ conversationId, actorUserId: senderUserId, presentUserIds });
  };
};

/**
 * The chat slice's runless user-only send push capability. A per-request
 * factory (not a pre-bound closure) because the chat route holds only the
 * request's `env`/`db`; it hands the returned capability its fire-time presence
 * snapshot.
 */
export function createChatMessagePushNotify(env: Bindings, db: Database): NotifyNewMessage {
  const notify = createCategoryPushNotify('message', {
    env,
    db,
    telemetry: createConsoleTelemetry(),
    membership: createPushMembershipReader(db),
  });
  return async ({ conversationId, senderUserId, presentUserIds }) => {
    await notify({ conversationId, actorUserId: senderUserId, presentUserIds });
  };
}

/**
 * The conversations slice's membership-event capability (added to a
 * conversation, fork and share activity), built per request from the route's
 * `env`/`db`. Fired through `waitUntil` after the mutation commits.
 */
export function createMembershipPushNotify(env: Bindings, db: Database): NotifyConversationEvent {
  return createCategoryPushNotify('membership', {
    env,
    db,
    telemetry: createConsoleTelemetry(),
    membership: createPushMembershipReader(db),
  });
}
