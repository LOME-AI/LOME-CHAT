/**
 * Push permission as this app models it: the three browser/OS states plus
 * `unsupported` for a device with no push path at all (a browser without
 * `PushManager`, e.g. iOS Safari outside an installed home-screen app).
 */
export type PushPermissionState = 'granted' | 'denied' | 'default' | 'unsupported';

/**
 * The one client-side push surface. Web (Notification API + PushManager +
 * service worker) and native (Capacitor) implement it; callers never branch on
 * platform, and the permission state machine exists only here.
 */
export interface NotificationChannel {
  /** Current push permission for this device. Never prompts. */
  getPermissionState: () => Promise<PushPermissionState>;
  /**
   * Asks the platform for permission and, on grant, registers this device for
   * delivery. The only place a permission prompt is raised — it must be driven
   * by an explicit user action.
   */
  requestPermissionAndRegister: () => Promise<PushPermissionState>;
  /**
   * Re-registers an already-permitted device. Registration is one upsert, so
   * re-running it on every authenticated app start is also how a subscription
   * that the browser rotated or the server pruned heals itself.
   */
  ensureRegistered: () => Promise<void>;
  /** Stops delivery to this device: drops the platform registration and the server row. */
  unregister: () => Promise<void>;
  /**
   * Dismisses notifications already showing for these conversations, so a
   * conversation the user has since read stops nagging from the shade.
   *
   * Notifications are addressed by `conversationId`: that is the device-local
   * tag the display point sets from the payload. The server's collapse alias is
   * a push-service header only and is never derived on the client.
   */
  clearDelivered: (conversationIds: readonly string[]) => Promise<void>;
}
