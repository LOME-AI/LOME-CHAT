import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PushNotifications } from '@capacitor/push-notifications';
import { nativeNotificationChannel } from './native-adapter.js';

vi.mock('@capacitor/push-notifications', () => ({
  PushNotifications: {
    checkPermissions: vi.fn(() => Promise.resolve({ receive: 'prompt' })),
    requestPermissions: vi.fn(() => Promise.resolve({ receive: 'granted' })),
    register: vi.fn(() => Promise.resolve()),
    unregister: vi.fn(() => Promise.resolve()),
    getDeliveredNotifications: vi.fn(() => Promise.resolve({ notifications: [] })),
    removeDeliveredNotifications: vi.fn(() => Promise.resolve()),
  },
}));

const push = vi.mocked(PushNotifications);

describe('nativeNotificationChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getPermissionState', () => {
    it.each([
      ['granted', 'granted'],
      ['denied', 'denied'],
      ['prompt', 'default'],
      ['prompt-with-rationale', 'default'],
    ] as const)('maps the %s OS permission to %s', async (receive, expected) => {
      push.checkPermissions.mockResolvedValue({ receive });

      expect(await nativeNotificationChannel.getPermissionState()).toBe(expected);
    });

    it('never prompts', async () => {
      await nativeNotificationChannel.getPermissionState();

      expect(push.requestPermissions).not.toHaveBeenCalled();
    });
  });

  describe('requestPermissionAndRegister', () => {
    it('registers for remote notifications once permission is granted', async () => {
      push.requestPermissions.mockResolvedValue({ receive: 'granted' });

      expect(await nativeNotificationChannel.requestPermissionAndRegister()).toBe('granted');
      expect(push.register).toHaveBeenCalled();
    });

    it('does not register when permission is denied', async () => {
      push.requestPermissions.mockResolvedValue({ receive: 'denied' });

      expect(await nativeNotificationChannel.requestPermissionAndRegister()).toBe('denied');
      expect(push.register).not.toHaveBeenCalled();
    });
  });

  describe('ensureRegistered', () => {
    it('registers when the OS permission is already granted', async () => {
      push.checkPermissions.mockResolvedValue({ receive: 'granted' });

      await nativeNotificationChannel.ensureRegistered();

      expect(push.register).toHaveBeenCalled();
      expect(push.requestPermissions).not.toHaveBeenCalled();
    });

    it('does not register — or prompt — while permission is unresolved', async () => {
      push.checkPermissions.mockResolvedValue({ receive: 'prompt' });

      await nativeNotificationChannel.ensureRegistered();

      expect(push.register).not.toHaveBeenCalled();
      expect(push.requestPermissions).not.toHaveBeenCalled();
    });
  });

  it('unregister drops the platform registration', async () => {
    await nativeNotificationChannel.unregister();

    expect(push.unregister).toHaveBeenCalled();
  });

  describe('clearDelivered', () => {
    // A shade entry is addressed by the raw conversation id — never the
    // collapse alias, which stays on the transport headers. Android puts the id
    // in the notification tag and nothing useful in its extras; iOS has no tag
    // and puts the id in the data payload. Each fixture below models one of the
    // two, so neither platform's path can be dropped unnoticed.
    const CONVERSATION_ID = '018f4e2a-1c3b-7d4e-9f0a-1b2c3d4e5f60';
    const OTHER_ID = '018f4e2a-1c3b-7d4e-9f0a-1b2c3d4e5f61';

    function delivered(
      notifications: { id: string; tag?: string; data: unknown }[]
    ): ReturnType<typeof vi.fn> {
      return push.getDeliveredNotifications.mockResolvedValue({
        notifications,
      } as Awaited<ReturnType<typeof PushNotifications.getDeliveredNotifications>>);
    }

    it('removes the notification tagged with the conversation id (Android)', async () => {
      // Android extras, which carry no conversation id — the tag is the only
      // thing that can match, and it is what the sender stamps there.
      const mine = { id: '1', tag: CONVERSATION_ID, data: { title: 'Response ready' } };
      delivered([mine, { id: '2', tag: OTHER_ID, data: { title: 'New message' } }]);

      await nativeNotificationChannel.clearDelivered([CONVERSATION_ID]);

      expect(push.removeDeliveredNotifications).toHaveBeenCalledWith({ notifications: [mine] });
    });

    it('matches the conversation id carried in the data payload where no tag exists (iOS)', async () => {
      const mine = { id: '1', data: { conversationId: CONVERSATION_ID } };
      delivered([mine, { id: '2', data: { conversationId: OTHER_ID } }]);

      await nativeNotificationChannel.clearDelivered([CONVERSATION_ID]);

      expect(push.removeDeliveredNotifications).toHaveBeenCalledWith({ notifications: [mine] });
    });

    it('ignores a notification carrying no conversation at all', async () => {
      delivered([
        { id: '1', data: null },
        { id: '2', data: { conversationId: 7 } },
      ]);

      await nativeNotificationChannel.clearDelivered([CONVERSATION_ID]);

      expect(push.removeDeliveredNotifications).not.toHaveBeenCalled();
    });

    it('leaves the shade alone when nothing matches', async () => {
      delivered([{ id: '2', tag: OTHER_ID, data: {} }]);

      await nativeNotificationChannel.clearDelivered([CONVERSATION_ID]);

      expect(push.removeDeliveredNotifications).not.toHaveBeenCalled();
    });

    it('does not read the shade when asked to clear nothing', async () => {
      await nativeNotificationChannel.clearDelivered([]);

      expect(push.getDeliveredNotifications).not.toHaveBeenCalled();
    });
  });
});
