import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isNative } from '@/capacitor/platform';
import { webNotificationChannel } from './web-adapter.js';
import { nativeNotificationChannel } from './native-adapter.js';
import { notificationChannel } from './channel.js';

vi.mock('@/capacitor/platform', () => ({ isNative: vi.fn() }));
vi.mock('./web-adapter.js', () => ({
  webNotificationChannel: {
    getPermissionState: vi.fn(() => Promise.resolve('default')),
    requestPermissionAndRegister: vi.fn(() => Promise.resolve('granted')),
    ensureRegistered: vi.fn(() => Promise.resolve()),
    unregister: vi.fn(() => Promise.resolve()),
    clearDelivered: vi.fn(() => Promise.resolve()),
  },
}));
vi.mock('./native-adapter.js', () => ({
  nativeNotificationChannel: {
    getPermissionState: vi.fn(() => Promise.resolve('denied')),
    requestPermissionAndRegister: vi.fn(() => Promise.resolve('denied')),
    ensureRegistered: vi.fn(() => Promise.resolve()),
    unregister: vi.fn(() => Promise.resolve()),
    clearDelivered: vi.fn(() => Promise.resolve()),
  },
}));

const isNativeMock = vi.mocked(isNative);

describe('notificationChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('delegates every call to the web adapter on the web', async () => {
    isNativeMock.mockReturnValue(false);

    expect(await notificationChannel.getPermissionState()).toBe('default');
    expect(await notificationChannel.requestPermissionAndRegister()).toBe('granted');
    await notificationChannel.ensureRegistered();
    await notificationChannel.unregister();
    await notificationChannel.clearDelivered(['conversation-a']);

    expect(webNotificationChannel.ensureRegistered).toHaveBeenCalled();
    expect(webNotificationChannel.unregister).toHaveBeenCalled();
    expect(webNotificationChannel.clearDelivered).toHaveBeenCalledWith(['conversation-a']);
    expect(nativeNotificationChannel.getPermissionState).not.toHaveBeenCalled();
  });

  it('delegates every call to the native adapter inside the shell', async () => {
    isNativeMock.mockReturnValue(true);

    expect(await notificationChannel.getPermissionState()).toBe('denied');
    expect(await notificationChannel.requestPermissionAndRegister()).toBe('denied');
    await notificationChannel.ensureRegistered();
    await notificationChannel.unregister();
    await notificationChannel.clearDelivered(['conversation-a']);

    expect(nativeNotificationChannel.ensureRegistered).toHaveBeenCalled();
    expect(nativeNotificationChannel.unregister).toHaveBeenCalled();
    expect(nativeNotificationChannel.clearDelivered).toHaveBeenCalledWith(['conversation-a']);
    expect(webNotificationChannel.getPermissionState).not.toHaveBeenCalled();
  });
});
