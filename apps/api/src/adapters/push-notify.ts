import {
  createDeviceTokenStore,
  createPushSenderFromEnv,
  sendPushForNewMessage,
} from '../slices/notifications/index.js';
import { okAsync } from '../lib/result/index.js';
import type { PushNotifyFactory } from '../slices/conversations/adapters/realtime-room-bindings.js';
import type { PresenceReader } from '../slices/notifications/index.js';

/**
 * The composition root's push capability for a persisted new message. It binds
 * the notifications-barrel wiring (device-token store, push sender, the
 * recipient selector) that a conversations adapter may not import, and closes
 * over the injected membership read. Fired best-effort at a run's terminal
 * sink — the returned function never throws and never blocks completion.
 *
 * Message content NEVER reaches the payload: the title/body are fixed generic
 * copy (a push notification sits outside the E2E envelope), and presence rides
 * the caller's fire-time snapshot so members already watching are suppressed.
 */

/** Generic, content-free push copy — the message itself never appears here. */
export const NEW_MESSAGE_PUSH_TITLE = 'New message';
export const NEW_MESSAGE_PUSH_BODY = 'You have a new message in a conversation.';

export const createMessagePushNotify: PushNotifyFactory = ({ env, db, telemetry, membership }) => {
  const push = createPushSenderFromEnv(env);
  const deviceTokens = createDeviceTokenStore(db);
  return async ({ conversationId, senderUserId, presentUserIds }) => {
    // Presence is the caller's fire-time snapshot — no live DO round trip.
    const presence: PresenceReader = { presence: () => okAsync(presentUserIds) };
    await sendPushForNewMessage(
      { membership, presence, deviceTokens, push, logger: telemetry },
      {
        conversationId,
        senderUserId,
        title: NEW_MESSAGE_PUSH_TITLE,
        body: NEW_MESSAGE_PUSH_BODY,
      }
    ).match(
      () => {
        // Delivered (or nothing to deliver) — best-effort, nothing to do.
      },
      () => {
        // sendPushForNewMessage already logged the code; swallow the Result so
        // the capability resolves void (best-effort).
      }
    );
  };
};
