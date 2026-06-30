import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sendPushForNewMessage } from './trigger.js';
import type { PushClient } from './types.js';
import type { Database } from '@hushbox/db';

function createMockPushClient(): PushClient & { send: ReturnType<typeof vi.fn> } {
  return {
    send: vi.fn().mockResolvedValue({ successCount: 1, failureCount: 0 }),
  };
}

/**
 * Mock DB for the trigger service.
 * Query 1: active members excluding sender (select → from → where → then)
 * Query 2: device tokens for those members (select → from → where → then)
 */
/* eslint-disable unicorn/no-thenable -- mock Drizzle query builder chain */
function createMockDb(
  members: { userId: string; muted: boolean }[],
  tokens: { userId: string; token: string; platform: string }[]
): unknown {
  let queryIndex = 0;

  const makeChain = (): Record<string, unknown> => ({
    from: () => makeChain(),
    where: () => makeChain(),
    then: (resolve: (v: unknown[]) => unknown) => {
      const result = queryIndex === 0 ? members : tokens;
      queryIndex++;
      return Promise.resolve(resolve(result));
    },
  });

  return {
    select: () => makeChain(),
  };
}
/* eslint-enable unicorn/no-thenable */

describe('sendPushForNewMessage', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('sends push to all unmuted members with device tokens', async () => {
    const pushClient = createMockPushClient();
    const db = createMockDb(
      [
        { userId: 'user-2', muted: false },
        { userId: 'user-3', muted: false },
      ],
      [
        { userId: 'user-2', token: 'fcm-token-2', platform: 'android' },
        { userId: 'user-3', token: 'fcm-token-3', platform: 'ios' },
      ]
    ) as Database;

    await sendPushForNewMessage({
      db,
      pushClient,
      conversationId: 'conv-1',
      senderUserId: 'user-1',
      title: 'New Message',
      body: 'Hello from User 1',
    });

    expect(pushClient.send).toHaveBeenCalledTimes(1);
    expect(pushClient.send).toHaveBeenCalledWith({
      tokens: ['fcm-token-2', 'fcm-token-3'],
      title: 'New Message',
      body: 'Hello from User 1',
      data: { conversationId: 'conv-1' },
    });
  });

  it('skips muted members', async () => {
    const pushClient = createMockPushClient();
    const db = createMockDb(
      [
        { userId: 'user-2', muted: true },
        { userId: 'user-3', muted: false },
      ],
      [{ userId: 'user-3', token: 'fcm-token-3', platform: 'ios' }]
    ) as Database;

    await sendPushForNewMessage({
      db,
      pushClient,
      conversationId: 'conv-1',
      senderUserId: 'user-1',
      title: 'New Message',
      body: 'Hello',
    });

    expect(pushClient.send).toHaveBeenCalledTimes(1);
    expect(pushClient.send).toHaveBeenCalledWith(
      expect.objectContaining({
        tokens: ['fcm-token-3'],
      })
    );
  });

  it('does not call send when no tokens found', async () => {
    const pushClient = createMockPushClient();
    const db = createMockDb([{ userId: 'user-2', muted: false }], []) as Database;

    await sendPushForNewMessage({
      db,
      pushClient,
      conversationId: 'conv-1',
      senderUserId: 'user-1',
      title: 'New Message',
      body: 'Hello',
    });

    expect(pushClient.send).not.toHaveBeenCalled();
  });

  it('does not call send when all members are muted', async () => {
    const pushClient = createMockPushClient();
    const db = createMockDb([{ userId: 'user-2', muted: true }], []) as Database;

    await sendPushForNewMessage({
      db,
      pushClient,
      conversationId: 'conv-1',
      senderUserId: 'user-1',
      title: 'New Message',
      body: 'Hello',
    });

    expect(pushClient.send).not.toHaveBeenCalled();
  });

  it('does not call send when no other members exist', async () => {
    const pushClient = createMockPushClient();
    const db = createMockDb([], []) as Database;

    await sendPushForNewMessage({
      db,
      pushClient,
      conversationId: 'conv-1',
      senderUserId: 'user-1',
      title: 'New Message',
      body: 'Hello',
    });

    expect(pushClient.send).not.toHaveBeenCalled();
  });

  it('does not throw on push client failure', async () => {
    const pushClient = createMockPushClient();
    pushClient.send.mockRejectedValue(new Error('FCM unavailable'));
    const db = createMockDb(
      [{ userId: 'user-2', muted: false }],
      [{ userId: 'user-2', token: 'fcm-token-2', platform: 'android' }]
    ) as Database;

    await sendPushForNewMessage({
      db,
      pushClient,
      conversationId: 'conv-1',
      senderUserId: 'user-1',
      title: 'New Message',
      body: 'Hello',
    });

    expect(pushClient.send).toHaveBeenCalledTimes(1);
  });

  it('skips members whose userId is in activeUserIds (actively viewing the conversation)', async () => {
    const pushClient = createMockPushClient();
    // The mock DB doesn't honor the WHERE clause; seed tokens with only the
    // recipient set the real query would return (`inArray(userId, ['user-3'])`).
    const db = createMockDb(
      [
        { userId: 'user-2', muted: false },
        { userId: 'user-3', muted: false },
      ],
      [{ userId: 'user-3', token: 'fcm-token-3', platform: 'ios' }]
    ) as Database;

    await sendPushForNewMessage({
      db,
      pushClient,
      conversationId: 'conv-1',
      senderUserId: 'user-1',
      title: 'New Message',
      body: 'Hello',
      activeUserIds: new Set(['user-2']),
    });

    expect(pushClient.send).toHaveBeenCalledTimes(1);
    expect(pushClient.send).toHaveBeenCalledWith(
      expect.objectContaining({
        tokens: ['fcm-token-3'],
      })
    );
  });

  it('does not call send when all unmuted members are actively viewing', async () => {
    const pushClient = createMockPushClient();
    const db = createMockDb([{ userId: 'user-2', muted: false }], []) as Database;

    await sendPushForNewMessage({
      db,
      pushClient,
      conversationId: 'conv-1',
      senderUserId: 'user-1',
      title: 'New Message',
      body: 'Hello',
      activeUserIds: new Set(['user-2']),
    });

    expect(pushClient.send).not.toHaveBeenCalled();
  });

  it('treats undefined activeUserIds the same as an empty set (no filtering)', async () => {
    const pushClient = createMockPushClient();
    const db = createMockDb(
      [{ userId: 'user-2', muted: false }],
      [{ userId: 'user-2', token: 'fcm-token-2', platform: 'android' }]
    ) as Database;

    await sendPushForNewMessage({
      db,
      pushClient,
      conversationId: 'conv-1',
      senderUserId: 'user-1',
      title: 'New Message',
      body: 'Hello',
    });

    expect(pushClient.send).toHaveBeenCalledTimes(1);
    expect(pushClient.send).toHaveBeenCalledWith(
      expect.objectContaining({ tokens: ['fcm-token-2'] })
    );
  });
});
