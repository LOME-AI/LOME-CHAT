import { isNative } from '@/capacitor/platform';

/**
 * Register the push-only service worker at its stable `/sw.js` URL.
 *
 * Only on the web: inside the Capacitor native shell, FCM is the delivery path,
 * and a service worker would create a second push path on one platform. Resolves
 * to the registration (for the subscription lifecycle to attach a PushManager),
 * or `null` when it is skipped or unsupported.
 */
export async function registerPushServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (isNative()) return null;
  if (!('serviceWorker' in navigator)) return null;
  return navigator.serviceWorker.register('/sw.js');
}
