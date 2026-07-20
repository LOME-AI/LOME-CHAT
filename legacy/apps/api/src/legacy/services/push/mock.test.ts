import { describe, it, expect } from 'vitest';
import { createMockPushClient } from './mock.js';
import type { PushNotification } from './types.js';

describe('createMockPushClient', () => {
  const testNotification: PushNotification = {
    tokens: ['token-abc'],
    title: 'Test Title',
    body: 'Test Body',
  };

  it('returns a MockPushClient with send, getSentNotifications, and clearSentNotifications', () => {
    const client = createMockPushClient();

    expect(typeof client.send).toBe('function');
    expect(typeof client.getSentNotifications).toBe('function');
    expect(typeof client.clearSentNotifications).toBe('function');
  });

  it('records sent notifications', async () => {
    const client = createMockPushClient();

    await client.send(testNotification);

    expect(client.getSentNotifications()).toHaveLength(1);
    expect(client.getSentNotifications()[0]!.title).toBe('Test Title');
  });

  it('returns success count matching token count', async () => {
    const client = createMockPushClient();

    const result = await client.send({
      tokens: ['a', 'b', 'c'],
      title: 'T',
      body: 'B',
    });

    expect(result.successCount).toBe(3);
    expect(result.failureCount).toBe(0);
  });

  it('clears sent notifications', async () => {
    const client = createMockPushClient();

    await client.send(testNotification);
    expect(client.getSentNotifications()).toHaveLength(1);

    client.clearSentNotifications();
    expect(client.getSentNotifications()).toHaveLength(0);
  });

  it('returns copies of sent notifications', async () => {
    const client = createMockPushClient();

    await client.send(testNotification);

    const first = client.getSentNotifications();
    const second = client.getSentNotifications();
    expect(first).not.toBe(second);
    expect(first).toEqual(second);
  });
});
