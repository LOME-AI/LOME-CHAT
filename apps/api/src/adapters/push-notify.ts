import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { conversationMembers } from '@hushbox/db';
import {
  createDeviceTokenStore,
  createPushSenderFromEnv,
  sendPushForNewMessage,
} from '../slices/notifications/index.js';
import { fromPromise, okAsync } from '../lib/result/index.js';
import { unavailableError } from '../lib/errors/index.js';
import { createConsoleTelemetry } from '../lib/telemetry/index.js';
import type { Database } from '@hushbox/db';
import type { PushNotifyFactory } from '../slices/conversations/adapters/realtime-room-bindings.js';
import type { MembershipReader, PresenceReader } from '../slices/notifications/index.js';
import type { NotifyNewMessage } from '../slices/chat/index.js';
import type { Bindings } from '../lib/context/app-env.js';

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
  const push = createPushSenderFromEnv(env, db);
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

/**
 * The mute-aware active-user-member read the runless send's push needs. This
 * duplicates the conversations adapter's `createPushMembershipReader` (the same
 * `conversation_members` query) rather than reusing it BY NECESSITY: that
 * function shares a module with the ConversationRoom bindings, which value-
 * import the `@hushbox/realtime` barrel (and thus `cloudflare:workers`), so
 * importing it here would drag the workerd-only DO runtime into `app.ts` and
 * break its node-environment loading. Link guests carry a null `userId` and no
 * devices, so they are excluded at the query.
 */
function createChatPushMembershipReader(db: Database): MembershipReader {
  return {
    listActiveUserMembers: (conversationId) =>
      fromPromise(
        db
          .select({ userId: conversationMembers.userId, muted: conversationMembers.muted })
          .from(conversationMembers)
          .where(
            and(
              eq(conversationMembers.conversationId, conversationId),
              isNull(conversationMembers.leftAt),
              isNotNull(conversationMembers.userId)
            )
          ),
        (cause) => unavailableError('push membership read failed', cause)
      ).map((rows) =>
        rows.flatMap((row) =>
          row.userId === null ? [] : [{ userId: row.userId, muted: row.muted }]
        )
      ),
  };
}

/**
 * The chat slice's runless user-only send push capability, composed at the
 * composition root exactly like the DO's AI-turn push — the same
 * `createMessagePushNotify` wiring (push sender + device-token store + the
 * recipient selector), over a per-request `env`/`db`. A per-request factory
 * (not a pre-bound closure) because the chat route holds only the request's
 * `env` and `db`; it hands the returned `NotifyNewMessage` its fire-time
 * presence snapshot. Best-effort by construction — the returned function never
 * throws and never blocks the send's response.
 */
export function createChatMessagePushNotify(env: Bindings, db: Database): NotifyNewMessage {
  return createMessagePushNotify({
    env,
    db,
    telemetry: createConsoleTelemetry(),
    membership: createChatPushMembershipReader(db),
  });
}
