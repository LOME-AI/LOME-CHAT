import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { dispatchPushNotification } from './dispatch.js';
import type { Database } from '@hushbox/db';
import type { Bindings } from '../../types.js';
import type { PushClient } from './types.js';

function createMockPushClient(): PushClient & { send: ReturnType<typeof vi.fn> } {
  return {
    send: vi.fn().mockResolvedValue({ successCount: 0, failureCount: 0 }),
  };
}

describe('dispatchPushNotification', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('calls sendPushForNewMessage with the constructed push client', async () => {
    const pushClient = createMockPushClient();
    const getPushClient = vi.fn().mockReturnValue(pushClient);
    const sendPushForNewMessage = vi.fn(() => Promise.resolve());

    dispatchPushNotification({
      env: {} as Bindings,
      db: {} as Database,
      conversationId: 'conv-1',
      senderUserId: 'user-1',
      title: 'New Message',
      body: 'You have a new message',
      activeUserIds: new Set<string>(),
      deps: { getPushClient, sendPushForNewMessage },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sendPushForNewMessage).toHaveBeenCalledTimes(1);
    expect(sendPushForNewMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        pushClient,
        conversationId: 'conv-1',
        senderUserId: 'user-1',
        title: 'New Message',
        body: 'You have a new message',
        activeUserIds: expect.any(Set),
      })
    );
  });

  it('forwards activeUserIds to sendPushForNewMessage so active viewers are skipped', async () => {
    const getPushClient = vi.fn().mockReturnValue(createMockPushClient());
    const sendPushForNewMessage = vi.fn(() => Promise.resolve());
    const activeUserIds = new Set(['user-2', 'user-3']);

    dispatchPushNotification({
      env: {} as Bindings,
      db: {} as Database,
      conversationId: 'conv-1',
      senderUserId: 'user-1',
      title: 't',
      body: 'b',
      activeUserIds,
      deps: { getPushClient, sendPushForNewMessage },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sendPushForNewMessage).toHaveBeenCalledWith(expect.objectContaining({ activeUserIds }));
  });

  it('does not throw when getPushClient throws synchronously', () => {
    const getPushClient = vi.fn().mockImplementation(() => {
      throw new Error('FCM credentials missing');
    });
    const sendPushForNewMessage = vi.fn(() => Promise.resolve());

    expect(() => {
      dispatchPushNotification({
        env: {} as Bindings,
        db: {} as Database,
        conversationId: 'conv-1',
        senderUserId: 'user-1',
        title: 't',
        body: 'b',
        activeUserIds: new Set(),
        deps: { getPushClient, sendPushForNewMessage },
      });
    }).not.toThrow();
  });

  it('logs to console.error when getPushClient throws synchronously', async () => {
    const getPushClient = vi.fn().mockImplementation(() => {
      throw new Error('FCM credentials missing');
    });
    const sendPushForNewMessage = vi.fn(() => Promise.resolve());

    dispatchPushNotification({
      env: {} as Bindings,
      db: {} as Database,
      conversationId: 'conv-1',
      senderUserId: 'user-1',
      title: 't',
      body: 'b',
      activeUserIds: new Set(),
      deps: { getPushClient, sendPushForNewMessage },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(consoleSpy).toHaveBeenCalledWith(
      '[fire-and-forget] send push notifications for AI response:',
      expect.any(Error)
    );
  });

  it('does not call sendPushForNewMessage when getPushClient throws', async () => {
    const getPushClient = vi.fn().mockImplementation(() => {
      throw new Error('FCM credentials missing');
    });
    const sendPushForNewMessage = vi.fn(() => Promise.resolve());

    dispatchPushNotification({
      env: {} as Bindings,
      db: {} as Database,
      conversationId: 'conv-1',
      senderUserId: 'user-1',
      title: 't',
      body: 'b',
      activeUserIds: new Set(),
      deps: { getPushClient, sendPushForNewMessage },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sendPushForNewMessage).not.toHaveBeenCalled();
  });

  it('calls executionCtx.waitUntil when provided', () => {
    const getPushClient = vi.fn().mockReturnValue(createMockPushClient());
    const sendPushForNewMessage = vi.fn(() => Promise.resolve());
    const waitUntil = vi.fn();

    dispatchPushNotification({
      env: {} as Bindings,
      db: {} as Database,
      conversationId: 'conv-1',
      senderUserId: 'user-1',
      title: 't',
      body: 'b',
      activeUserIds: new Set(),
      executionCtx: { waitUntil },
      deps: { getPushClient, sendPushForNewMessage },
    });

    expect(waitUntil).toHaveBeenCalledOnce();
  });

  it('uses the real getPushClient and sendPushForNewMessage when deps are omitted', async () => {
    // Smoke test: with no deps argument, the production wiring is reachable
    // and the call doesn't throw. The real `sendPushForNewMessage` swallows
    // its own errors (push is best-effort) so the proxy-db throw stays
    // inside it and we just assert the call surface is wired up correctly.
    const env: Bindings = {
      DATABASE_URL: 'postgres://test',
      APP_VERSION: '0.0.0-test',
      CI: 'true',
    };
    const dbAccessed = vi.fn();
    const db = new Proxy({} as Database, {
      get() {
        dbAccessed();
        throw new Error('db-touched');
      },
    });

    expect(() => {
      dispatchPushNotification({
        env,
        db,
        conversationId: 'conv-1',
        senderUserId: 'user-1',
        title: 't',
        body: 'b',
        activeUserIds: new Set(),
      });
    }).not.toThrow();

    await new Promise((resolve) => setTimeout(resolve, 0));

    // The real trigger reached the db (proof the default sendPushForNewMessage
    // ran), and the throw stayed inside trigger.ts's silent catch.
    expect(dbAccessed).toHaveBeenCalled();
  });
});
