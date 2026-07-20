import { fireAndForget } from '../../lib/fire-and-forget.js';
import { getPushClient as realGetPushClient } from './factory.js';
import { sendPushForNewMessage as realSendPushForNewMessage } from './trigger.js';
import type { Database } from '@hushbox/db';
import type { Bindings } from '../../types.js';
import type { PushClient } from './types.js';

/**
 * Pluggable seams for testing. Defaulted to the production implementations
 * so the typical caller passes nothing. Tests inject mocks directly instead
 * of module-namespace spying, which is fragile under bundler changes.
 */
export interface DispatchPushNotificationDeps {
  getPushClient: (env: Bindings) => PushClient;
  sendPushForNewMessage: (params: {
    db: Database;
    pushClient: PushClient;
    conversationId: string;
    senderUserId: string;
    title: string;
    body: string;
    activeUserIds?: Set<string>;
  }) => Promise<void>;
}

export interface DispatchPushNotificationParams {
  env: Bindings;
  db: Database;
  conversationId: string;
  senderUserId: string;
  title: string;
  body: string;
  /**
   * User ids currently connected to this conversation's Durable Object. Push
   * notifications are suppressed for these users — they already see the new
   * message inline via the WebSocket `message:complete` event.
   */
  activeUserIds: Set<string>;
  executionCtx?: { waitUntil(p: Promise<unknown>): void };
  deps?: DispatchPushNotificationDeps;
}

/**
 * Fire-and-forget push notification dispatch for a new AI message.
 *
 * The push-client construction (`deps.getPushClient(env)`) is deliberately
 * deferred into the async body so any synchronous throw — e.g., missing FCM
 * credentials in production — lands in `fireAndForget`'s try/catch instead of
 * escaping into the calling SSE pipeline. A construction failure here must
 * not fail-cascade into the assistant turn the user is actively receiving.
 */
export function dispatchPushNotification(params: DispatchPushNotificationParams): void {
  const { env, db, conversationId, senderUserId, title, body, activeUserIds, executionCtx } =
    params;
  const getPushClient = params.deps?.getPushClient ?? realGetPushClient;
  const sendPushForNewMessage = params.deps?.sendPushForNewMessage ?? realSendPushForNewMessage;

  fireAndForget(
    (async (): Promise<void> => {
      const pushClient = getPushClient(env);
      await sendPushForNewMessage({
        db,
        pushClient,
        conversationId,
        senderUserId,
        title,
        body,
        activeUserIds,
      });
    })(),
    'send push notifications for AI response',
    executionCtx
  );
}
