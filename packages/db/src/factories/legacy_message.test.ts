import { describe, it, expect } from 'vitest';

import { messageFactory } from './legacy_message';

describe('messageFactory', () => {
  it('builds a complete message envelope', () => {
    const message = messageFactory.build();

    expect(message.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(message.conversationId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(['user', 'ai']).toContain(message.senderType);
    expect(message.wrappedContentKey).toBeInstanceOf(Uint8Array);
    expect(message.wrappedContentKey.length).toBeGreaterThan(0);
    expect(message.createdAt).toBeInstanceOf(Date);
  });

  it('generates epoch and sequence fields', () => {
    const message = messageFactory.build();

    expect(message.epochNumber).toBe(1);
    expect(message.sequenceNumber).toBeGreaterThanOrEqual(1);
  });

  it('generates senderId as UUID', () => {
    const message = messageFactory.build();

    expect(message.senderId).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('allows field overrides', () => {
    const customKey = new Uint8Array(49).fill(7);
    const message = messageFactory.build({
      senderType: 'ai',
      wrappedContentKey: customKey,
    });
    expect(message.senderType).toBe('ai');
    expect(message.wrappedContentKey).toEqual(customKey);
  });

  it('builds a list with unique IDs', () => {
    const messageList = messageFactory.buildList(3);
    expect(messageList).toHaveLength(3);
    const ids = new Set(messageList.map((m) => m.id));
    expect(ids.size).toBe(3);
  });

  it('defaults parent_message_id to null', () => {
    const message = messageFactory.build();
    expect(message.parentMessageId).toBeNull();
  });
});
