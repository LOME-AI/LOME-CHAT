import { describe, it, expect } from 'vitest';

import { conversationFactory } from './legacy_conversation';

describe('conversationFactory', () => {
  it('builds a complete conversation object', () => {
    const conversation = conversationFactory.build();

    expect(conversation.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(conversation.userId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(conversation.title).toBeInstanceOf(Uint8Array);
    expect(conversation.createdAt).toBeInstanceOf(Date);
    expect(conversation.updatedAt).toBeInstanceOf(Date);
  });

  it('generates epoch and sequence fields with correct defaults', () => {
    const conversation = conversationFactory.build();

    expect(conversation.titleEpochNumber).toBe(1);
    expect(conversation.currentEpoch).toBe(1);
    expect(conversation.nextSequence).toBe(1);
  });

  it('generates nullable fields as null by default', () => {
    const conversation = conversationFactory.build();

    expect(conversation.projectId).toBeNull();
  });

  it('defaults conversationBudget to zero', () => {
    const conversation = conversationFactory.build();

    expect(conversation.conversationBudget).toBe('0.00');
  });

  it('allows field overrides', () => {
    const customTitle = new TextEncoder().encode('Custom Title');
    const conversation = conversationFactory.build({ title: customTitle });
    expect(conversation.title).toEqual(customTitle);
  });

  it('builds a list with unique IDs', () => {
    const conversationList = conversationFactory.buildList(3);
    expect(conversationList).toHaveLength(3);
    const ids = new Set(conversationList.map((c) => c.id));
    expect(ids.size).toBe(3);
  });
});
