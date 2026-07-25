import { isNative } from '@/capacitor/platform';
import { webNotificationChannel } from './web-adapter.js';
import { nativeNotificationChannel } from './native-adapter.js';
import type { NotificationChannel, PushPermissionState } from './types.js';

function adapter(): NotificationChannel {
  return isNative() ? nativeNotificationChannel : webNotificationChannel;
}

/**
 * The push facade every caller uses. Delegation is per call rather than a
 * module-load pick so the adapter choice stays a pure function of the platform.
 */
export const notificationChannel: NotificationChannel = {
  getPermissionState: (): Promise<PushPermissionState> => adapter().getPermissionState(),
  requestPermissionAndRegister: (): Promise<PushPermissionState> =>
    adapter().requestPermissionAndRegister(),
  ensureRegistered: (): Promise<void> => adapter().ensureRegistered(),
  unregister: (): Promise<void> => adapter().unregister(),
  clearDelivered: (conversationIds: readonly string[]): Promise<void> =>
    adapter().clearDelivered(conversationIds),
};
