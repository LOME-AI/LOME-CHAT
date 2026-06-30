import { describe, it, expect } from 'vitest';
import { createMockEmailSender } from './email-mock.js';

const message = {
  to: 'user@example.com',
  subject: 'Test Subject',
  html: '<p>Test body</p>',
};

describe('createMockEmailSender', () => {
  it('resolves ok for a sent message', async () => {
    const sender = createMockEmailSender();

    const result = await sender.send(message);

    expect(result.isOk()).toBe(true);
  });

  it('records sent messages', async () => {
    const sender = createMockEmailSender();

    const sent = await sender.send(message);

    expect(sent.isOk()).toBe(true);
    expect(sender.getSentMessages()).toEqual([message]);
  });

  it('returns a defensive copy of the sent list', async () => {
    const sender = createMockEmailSender();
    const sent = await sender.send(message);
    expect(sent.isOk()).toBe(true);

    const snapshot = sender.getSentMessages();

    expect(snapshot).not.toBe(sender.getSentMessages());
  });

  it('clears recorded messages', async () => {
    const sender = createMockEmailSender();
    const sent = await sender.send(message);
    expect(sent.isOk()).toBe(true);

    sender.clearSentMessages();

    expect(sender.getSentMessages()).toEqual([]);
  });
});
