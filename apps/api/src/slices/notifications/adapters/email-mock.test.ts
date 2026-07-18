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

  it('records custom headers on a sent message', async () => {
    const sender = createMockEmailSender();

    const sent = await sender.send({ ...message, headers: { 'List-Unsubscribe': '<mailto:x@y>' } });

    expect(sent.isOk()).toBe(true);
    expect(sender.getSentMessages()[0]?.headers).toEqual({ 'List-Unsubscribe': '<mailto:x@y>' });
  });

  it('clears recorded messages', async () => {
    const sender = createMockEmailSender();
    const sent = await sender.send(message);
    expect(sent.isOk()).toBe(true);

    sender.clearSentMessages();

    expect(sender.getSentMessages()).toEqual([]);
  });

  it('returns one synthetic id per batched message, index-matched', async () => {
    const sender = createMockEmailSender();

    const result = await sender.sendBatch([message, { ...message, to: 'b@example.com' }], {
      idempotencyKey: 'newsletter:issue:0',
    });

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().ids).toHaveLength(2);
    expect(new Set(result._unsafeUnwrap().ids).size).toBe(2);
  });

  it('records the batch with its idempotency key', async () => {
    const sender = createMockEmailSender();

    const result = await sender.sendBatch([message], { idempotencyKey: 'newsletter:issue:3' });

    expect(result.isOk()).toBe(true);
    expect(sender.getSentBatches()).toEqual([
      { messages: [message], idempotencyKey: 'newsletter:issue:3' },
    ]);
  });

  it('appends batched messages to the sent list', async () => {
    const sender = createMockEmailSender();

    const result = await sender.sendBatch([message], { idempotencyKey: 'k' });

    expect(result.isOk()).toBe(true);
    expect(sender.getSentMessages()).toEqual([message]);
  });

  it('rejects a batch over the 100-message provider cap', async () => {
    const sender = createMockEmailSender();
    const oversized = Array.from({ length: 101 }, () => message);

    const result = await sender.sendBatch(oversized, { idempotencyKey: 'k' });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('clears recorded batches with the sent list', async () => {
    const sender = createMockEmailSender();
    const result = await sender.sendBatch([message], { idempotencyKey: 'k' });
    expect(result.isOk()).toBe(true);

    sender.clearSentMessages();

    expect(sender.getSentBatches()).toEqual([]);
  });
});
