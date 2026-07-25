import { describe, it, expect } from 'vitest';
import { createMockPushSender } from './push-mock.js';
import type { PushMessage } from '../ports/index.js';

const message: PushMessage = {
  recipients: [
    { platform: 'ios', userId: 'user-a', token: 'token-a' },
    { platform: 'android', userId: 'user-b', token: 'token-b' },
  ],
  title: 'New Message',
  body: 'You have a new message',
};

describe('createMockPushSender', () => {
  it('reports every token as delivered', async () => {
    const sender = createMockPushSender();

    const result = await sender.send(message);

    expect(result._unsafeUnwrap()).toEqual({
      successCount: 2,
      failureCount: 0,
      deliveredTokens: [
        { userId: 'user-a', token: 'token-a' },
        { userId: 'user-b', token: 'token-b' },
      ],
      deadTokens: [],
    });
  });

  it('records sent messages', async () => {
    const sender = createMockPushSender();

    const sent = await sender.send(message);

    expect(sent.isOk()).toBe(true);
    expect(sender.getSentMessages()).toEqual([message]);
  });

  it('returns a defensive copy of the sent list', async () => {
    const sender = createMockPushSender();
    const sent = await sender.send(message);
    expect(sent.isOk()).toBe(true);

    expect(sender.getSentMessages()).not.toBe(sender.getSentMessages());
  });

  it('clears recorded messages', async () => {
    const sender = createMockPushSender();
    const sent = await sender.send(message);
    expect(sent.isOk()).toBe(true);

    sender.clearSentMessages();

    expect(sender.getSentMessages()).toEqual([]);
  });
});
