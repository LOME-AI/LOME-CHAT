import type { MockPushClient, PushNotification, PushResult } from './types.js';

export function createMockPushClient(): MockPushClient {
  const sentNotifications: PushNotification[] = [];

  return {
    send(notification: PushNotification): Promise<PushResult> {
      sentNotifications.push({ ...notification });
      return Promise.resolve({
        successCount: notification.tokens.length,
        failureCount: 0,
      });
    },

    getSentNotifications(): PushNotification[] {
      return [...sentNotifications];
    },

    clearSentNotifications(): void {
      sentNotifications.length = 0;
    },
  };
}
