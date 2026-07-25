import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { registerPushServiceWorker } from '@/lib/register-sw';
import { client, fetchJson } from '@/lib/api-client';
import { webNotificationChannel } from './web-adapter.js';

vi.mock('@/lib/register-sw', () => ({ registerPushServiceWorker: vi.fn() }));
vi.mock('@/lib/api-client', () => ({
  fetchJson: vi.fn(() => Promise.resolve({ registered: true })),
  client: {
    notifications: {
      'web-subscriptions': { $post: vi.fn() },
      'device-tokens': { ':token': { $delete: vi.fn() } },
    },
  },
}));

const registerSw = vi.mocked(registerPushServiceWorker);
const post = vi.mocked(client.notifications['web-subscriptions'].$post);
const del = vi.mocked(client.notifications['device-tokens'][':token'].$delete);

const SUBSCRIPTION_JSON = {
  endpoint: 'https://push.example.com/abc',
  keys: { p256dh: 'BPublicKey', auth: 'AuthSecret' },
};

function fakeSubscription(overrides: { unsubscribe?: () => Promise<boolean> } = {}): {
  endpoint: string;
  toJSON: () => typeof SUBSCRIPTION_JSON;
  unsubscribe: () => Promise<boolean>;
} {
  return {
    endpoint: SUBSCRIPTION_JSON.endpoint,
    toJSON: () => SUBSCRIPTION_JSON,
    unsubscribe: overrides.unsubscribe ?? vi.fn(() => Promise.resolve(true)),
  };
}

interface PushManagerStub {
  getSubscription: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
}

interface NotificationStub {
  tag: string;
  close: ReturnType<typeof vi.fn>;
}

function fakeNotification(tag: string): NotificationStub {
  return { tag, close: vi.fn() };
}

function stubSupportedBrowser(
  options: {
    permission?: NotificationPermission;
    pushManager?: PushManagerStub;
    delivered?: NotificationStub[];
  } = {}
): {
  pushManager: PushManagerStub;
  requestPermission: ReturnType<typeof vi.fn>;
  getNotifications: ReturnType<typeof vi.fn>;
} {
  const pushManager: PushManagerStub = options.pushManager ?? {
    getSubscription: vi.fn(() => Promise.resolve(null)),
    subscribe: vi.fn(() => Promise.resolve(fakeSubscription())),
  };
  const getNotifications = vi.fn(() => Promise.resolve(options.delivered ?? []));
  const registration = { pushManager, getNotifications };
  const requestPermission = vi.fn(() => Promise.resolve('granted'));
  vi.stubGlobal('PushManager', {});
  vi.stubGlobal('Notification', {
    permission: options.permission ?? 'default',
    requestPermission,
  });
  vi.stubGlobal('navigator', {
    serviceWorker: {
      ready: Promise.resolve(registration),
      getRegistration: vi.fn(() => Promise.resolve(registration)),
      register: vi.fn(),
    },
  });
  registerSw.mockResolvedValue(registration as unknown as ServiceWorkerRegistration);
  return { pushManager, requestPermission, getNotifications };
}

describe('webNotificationChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('VITE_VAPID_PUBLIC_KEY', 'BOeIadxzr8jCEiJstuK2');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  describe('getPermissionState', () => {
    it('reports unsupported when the browser has no PushManager', async () => {
      vi.stubGlobal('Notification', { permission: 'default' });
      vi.stubGlobal('navigator', { serviceWorker: {} });

      expect(await webNotificationChannel.getPermissionState()).toBe('unsupported');
    });

    it('reports unsupported when the browser has no service worker', async () => {
      vi.stubGlobal('PushManager', {});
      vi.stubGlobal('Notification', { permission: 'default' });
      vi.stubGlobal('navigator', {});

      expect(await webNotificationChannel.getPermissionState()).toBe('unsupported');
    });

    it('reports unsupported when the browser has no Notification API', async () => {
      vi.stubGlobal('PushManager', {});
      vi.stubGlobal('navigator', { serviceWorker: {} });

      expect(await webNotificationChannel.getPermissionState()).toBe('unsupported');
    });

    it('mirrors the browser permission when push is supported', async () => {
      stubSupportedBrowser({ permission: 'granted' });

      expect(await webNotificationChannel.getPermissionState()).toBe('granted');
    });
  });

  describe('requestPermissionAndRegister', () => {
    it('does not ask an unsupported browser for permission', async () => {
      vi.stubGlobal('navigator', {});

      expect(await webNotificationChannel.requestPermissionAndRegister()).toBe('unsupported');
      expect(registerSw).not.toHaveBeenCalled();
    });

    it('subscribes with the VAPID key and posts the subscription on grant', async () => {
      const { pushManager, requestPermission } = stubSupportedBrowser();

      const state = await webNotificationChannel.requestPermissionAndRegister();

      expect(state).toBe('granted');
      expect(requestPermission).toHaveBeenCalled();
      expect(pushManager.subscribe).toHaveBeenCalledWith({
        userVisibleOnly: true,
        applicationServerKey: expect.any(Uint8Array),
      });
      expect(post).toHaveBeenCalledWith({ json: SUBSCRIPTION_JSON });
      expect(fetchJson).toHaveBeenCalled();
    });

    it('does not subscribe when the user denies permission', async () => {
      const { pushManager, requestPermission } = stubSupportedBrowser();
      requestPermission.mockResolvedValue('denied');

      expect(await webNotificationChannel.requestPermissionAndRegister()).toBe('denied');
      expect(pushManager.subscribe).not.toHaveBeenCalled();
      expect(post).not.toHaveBeenCalled();
    });

    it('reuses an existing subscription instead of creating a second one', async () => {
      const pushManager: PushManagerStub = {
        getSubscription: vi.fn(() => Promise.resolve(fakeSubscription())),
        subscribe: vi.fn(),
      };
      stubSupportedBrowser({ pushManager });

      await webNotificationChannel.requestPermissionAndRegister();

      expect(pushManager.subscribe).not.toHaveBeenCalled();
      expect(post).toHaveBeenCalledWith({ json: SUBSCRIPTION_JSON });
    });

    it('fails fast when the VAPID public key is missing from the environment', async () => {
      vi.stubEnv('VITE_VAPID_PUBLIC_KEY', '');
      stubSupportedBrowser();

      await expect(webNotificationChannel.requestPermissionAndRegister()).rejects.toThrow();
    });

    it('skips registration when the service worker is unavailable', async () => {
      stubSupportedBrowser();
      registerSw.mockResolvedValue(null);

      expect(await webNotificationChannel.requestPermissionAndRegister()).toBe('granted');
      expect(post).not.toHaveBeenCalled();
    });
  });

  describe('ensureRegistered', () => {
    it('re-posts the existing subscription when permission is already granted', async () => {
      const pushManager: PushManagerStub = {
        getSubscription: vi.fn(() => Promise.resolve(fakeSubscription())),
        subscribe: vi.fn(),
      };
      const { requestPermission } = stubSupportedBrowser({ permission: 'granted', pushManager });

      await webNotificationChannel.ensureRegistered();

      expect(requestPermission).not.toHaveBeenCalled();
      expect(post).toHaveBeenCalledWith({ json: SUBSCRIPTION_JSON });
    });

    it('does nothing when permission has not been granted', async () => {
      stubSupportedBrowser({ permission: 'default' });

      await webNotificationChannel.ensureRegistered();

      expect(registerSw).not.toHaveBeenCalled();
      expect(post).not.toHaveBeenCalled();
    });
  });

  describe('unregister', () => {
    it('deletes the server row and unsubscribes locally', async () => {
      const unsubscribe = vi.fn(() => Promise.resolve(true));
      const pushManager: PushManagerStub = {
        getSubscription: vi.fn(() => Promise.resolve(fakeSubscription({ unsubscribe }))),
        subscribe: vi.fn(),
      };
      stubSupportedBrowser({ permission: 'granted', pushManager });

      await webNotificationChannel.unregister();

      expect(del).toHaveBeenCalledWith({
        param: { token: encodeURIComponent(SUBSCRIPTION_JSON.endpoint) },
      });
      expect(unsubscribe).toHaveBeenCalled();
    });

    it('still unsubscribes locally when the server delete fails', async () => {
      const unsubscribe = vi.fn(() => Promise.resolve(true));
      const pushManager: PushManagerStub = {
        getSubscription: vi.fn(() => Promise.resolve(fakeSubscription({ unsubscribe }))),
        subscribe: vi.fn(),
      };
      stubSupportedBrowser({ permission: 'granted', pushManager });
      vi.mocked(fetchJson).mockRejectedValueOnce(new Error('offline'));

      await webNotificationChannel.unregister();

      expect(unsubscribe).toHaveBeenCalled();
    });

    it('is a no-op when nothing is subscribed', async () => {
      stubSupportedBrowser({ permission: 'granted' });

      await webNotificationChannel.unregister();

      expect(del).not.toHaveBeenCalled();
    });

    it('is a no-op when no service worker is registered', async () => {
      stubSupportedBrowser({ permission: 'granted' });
      vi.stubGlobal('navigator', {
        serviceWorker: { getRegistration: vi.fn(() => Promise.resolve()) },
      });

      await webNotificationChannel.unregister();

      expect(del).not.toHaveBeenCalled();
    });

    it('is a no-op on an unsupported browser', async () => {
      vi.stubGlobal('navigator', {});

      await webNotificationChannel.unregister();

      expect(del).not.toHaveBeenCalled();
    });
  });

  describe('clearDelivered', () => {
    // The notification tag is the raw conversationId the worker set at show
    // time — a device-local value. Nothing here derives or consumes a
    // server-side collapse alias.
    const CONVERSATION_ID = '018f4e2a-1c3b-7d4e-9f0a-1b2c3d4e5f60';
    const OTHER_ID = '018f4e2a-1c3b-7d4e-9f0a-1b2c3d4e5f61';

    it('closes notifications tagged with the given conversation id', async () => {
      const mine = fakeNotification(CONVERSATION_ID);
      stubSupportedBrowser({ delivered: [mine] });

      await webNotificationChannel.clearDelivered([CONVERSATION_ID]);

      expect(mine.close).toHaveBeenCalledTimes(1);
    });

    it('leaves notifications for other conversations showing', async () => {
      const mine = fakeNotification(CONVERSATION_ID);
      const other = fakeNotification(OTHER_ID);
      stubSupportedBrowser({ delivered: [mine, other] });

      await webNotificationChannel.clearDelivered([CONVERSATION_ID]);

      expect(mine.close).toHaveBeenCalledTimes(1);
      expect(other.close).not.toHaveBeenCalled();
    });

    it('clears every conversation it is given in one pass', async () => {
      const mine = fakeNotification(CONVERSATION_ID);
      const other = fakeNotification(OTHER_ID);
      const { getNotifications } = stubSupportedBrowser({ delivered: [mine, other] });

      await webNotificationChannel.clearDelivered([CONVERSATION_ID, OTHER_ID]);

      expect(getNotifications).toHaveBeenCalledTimes(1);
      expect(mine.close).toHaveBeenCalledTimes(1);
      expect(other.close).toHaveBeenCalledTimes(1);
    });

    it('does not touch the notification list when asked to clear nothing', async () => {
      const { getNotifications } = stubSupportedBrowser();

      await webNotificationChannel.clearDelivered([]);

      expect(getNotifications).not.toHaveBeenCalled();
    });

    it('is a no-op when no service worker is registered', async () => {
      stubSupportedBrowser();
      vi.stubGlobal('navigator', {
        serviceWorker: { getRegistration: vi.fn(() => Promise.resolve()) },
      });

      await expect(
        webNotificationChannel.clearDelivered([CONVERSATION_ID])
      ).resolves.toBeUndefined();
    });

    it('is a no-op on an unsupported browser', async () => {
      vi.stubGlobal('navigator', {});

      await expect(
        webNotificationChannel.clearDelivered([CONVERSATION_ID])
      ).resolves.toBeUndefined();
    });
  });
});
