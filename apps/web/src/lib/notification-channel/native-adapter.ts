import { PushNotifications } from '@capacitor/push-notifications';
import type { NotificationChannel, PushPermissionState } from './types.js';
import type { PermissionState } from '@capacitor/core';
import type { PushNotificationSchema } from '@capacitor/push-notifications';

/**
 * Capacitor reports two flavours of "not decided yet" (`prompt` and
 * `prompt-with-rationale`); both are the state in which asking is legitimate.
 */
function toPermissionState(receive: PermissionState): PushPermissionState {
  if (receive === 'granted') return 'granted';
  if (receive === 'denied') return 'denied';
  return 'default';
}

/**
 * Which conversation a shade entry belongs to.
 *
 * Both platforms are needed, and neither covers the other. Android reports the
 * notification's tag — the raw conversation id the sender stamps there — while
 * its `data` is the Android notification extras, which never carry the id. iOS
 * reports no tag at all, but its `data` is the APNs userInfo, which does carry
 * the id. `data` is untyped platform JSON, hence the narrowing.
 */
function deliveredConversationId(notification: PushNotificationSchema): string | undefined {
  if (typeof notification.tag === 'string' && notification.tag.length > 0) return notification.tag;
  const data: unknown = notification.data;
  if (typeof data !== 'object' || data === null) return undefined;
  const conversationId = (data as Record<string, unknown>)['conversationId'];
  return typeof conversationId === 'string' ? conversationId : undefined;
}

/**
 * `PushNotifications.register()` is what makes the platform mint a token; the
 * token itself arrives on the `registration` listener the Capacitor shell keeps
 * mounted, which is where it is sent to the server.
 */
export const nativeNotificationChannel: NotificationChannel = {
  getPermissionState: async (): Promise<PushPermissionState> => {
    const { receive } = await PushNotifications.checkPermissions();
    return toPermissionState(receive);
  },

  requestPermissionAndRegister: async (): Promise<PushPermissionState> => {
    const { receive } = await PushNotifications.requestPermissions();
    const state = toPermissionState(receive);
    if (state === 'granted') await PushNotifications.register();
    return state;
  },

  ensureRegistered: async (): Promise<void> => {
    const { receive } = await PushNotifications.checkPermissions();
    if (toPermissionState(receive) !== 'granted') return;
    await PushNotifications.register();
  },

  unregister: async (): Promise<void> => {
    // Drops the platform registration, so the next send gets an UNREGISTERED
    // response and the server prunes the row through its one dead-token path.
    await PushNotifications.unregister();
  },

  clearDelivered: async (conversationIds: readonly string[]): Promise<void> => {
    if (conversationIds.length === 0) return;
    const targets = new Set(conversationIds);
    const { notifications } = await PushNotifications.getDeliveredNotifications();
    const matching = notifications.filter((notification) => {
      const conversationId = deliveredConversationId(notification);
      return conversationId !== undefined && targets.has(conversationId);
    });
    if (matching.length === 0) return;
    await PushNotifications.removeDeliveredNotifications({ notifications: matching });
  },
};
