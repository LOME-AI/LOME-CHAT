import { useEffect, useRef } from 'react';
import { PushNotifications } from '@capacitor/push-notifications';
import { isNative } from '../platform.js';

interface PushCallbacks {
  /** Called when FCM registration token is received. Send to `POST /notifications/device-tokens`. */
  onTokenReceived?: (token: string) => void;
  /** Called when the user taps a notification. Navigate to the relevant conversation. */
  onNotificationTap?: (data: Record<string, string>) => void;
}

/**
 * Registers for push notifications on native platforms.
 *
 * Requests permission, registers with FCM (Android) / APNs via FCM proxy (iOS),
 * and listens for token and notification tap events.
 * No-op on web.
 */
export function usePushNotifications(callbacks?: PushCallbacks): void {
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  useEffect(() => {
    if (!isNative()) return;

    const state = { cancelled: false };

    void (async () => {
      const result = await PushNotifications.requestPermissions();
      if (state.cancelled || result.receive !== 'granted') return;
      await PushNotifications.register();
    })();

    const registrationListener = PushNotifications.addListener('registration', (token) => {
      callbacksRef.current?.onTokenReceived?.(token.value);
    });

    const actionListener = PushNotifications.addListener(
      'pushNotificationActionPerformed',
      (event) => {
        callbacksRef.current?.onNotificationTap?.(
          event.notification.data as Record<string, string>
        );
      }
    );

    return () => {
      state.cancelled = true;
      void (async () => {
        const handle = await registrationListener;
        await handle.remove();
      })();
      void (async () => {
        const handle = await actionListener;
        await handle.remove();
      })();
    };
  }, []);
}
