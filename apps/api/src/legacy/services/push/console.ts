import type { PushClient, PushNotification, PushResult } from './types.js';

/* eslint-disable no-console -- dev-only push client that logs to console */
export function createConsolePushClient(): PushClient {
  return {
    send(notification: PushNotification): Promise<PushResult> {
      console.log('=== Push Notification ===');
      console.log(`Title: ${notification.title}`);
      console.log(`Body: ${notification.body}`);
      console.log(`Tokens: ${String(notification.tokens.length)} recipients`);
      if (notification.data) {
        console.log(`Data: ${JSON.stringify(notification.data)}`);
      }
      console.log('========================');

      return Promise.resolve({
        successCount: notification.tokens.length,
        failureCount: 0,
      });
    },
  };
}
