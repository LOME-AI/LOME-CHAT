import { handlePush, handleNotificationClick, handlePushSubscriptionChange } from './handlers.js';
import type { ServiceWorkerScope } from './handlers.js';

/**
 * Wire the push-only worker's event listeners. Deliberately registers no `fetch`
 * handler and performs no precaching, so the worker can never serve stale assets
 * or act as a second update mechanism alongside HTTP caching.
 */
export function registerServiceWorkerListeners(scope: ServiceWorkerScope): void {
  scope.addEventListener('push', (event) => {
    event.waitUntil(handlePush(scope, event));
  });
  scope.addEventListener('notificationclick', (event) => {
    event.waitUntil(handleNotificationClick(scope, event));
  });
  scope.addEventListener('pushsubscriptionchange', (event) => {
    event.waitUntil(handlePushSubscriptionChange(scope, event));
  });
}
