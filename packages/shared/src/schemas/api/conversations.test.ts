import { describe, it, expect } from 'vitest';
import {
  createConversationRequestSchema,
  updateConversationRequestSchema,
  createMessageRequestSchema,
  conversationResponseSchema,
  messageResponseSchema,
  listConversationsResponseSchema,
  getConversationResponseSchema,
  createConversationResponseSchema,
  updateConversationResponseSchema,
  deleteConversationResponseSchema,
  createMessageResponseSchema,
} from './conversations.js';

describe('createConversationRequestSchema', () => {
  it('accepts empty object with optional fields', () => {
    const result = createConversationRequestSchema.parse({});
    expect(result.title).toBeUndefined();
    expect(result.firstMessage).toBeUndefined();
  });

  it('accepts custom title', () => {
    const result = createConversationRequestSchema.parse({ title: 'My Chat' });
    expect(result.title).toBe('My Chat');
  });

  it('accepts firstMessage with content', () => {
    const result = createConversationRequestSchema.parse({
      firstMessage: { content: 'Hello world' },
    });
    expect(result.firstMessage?.content).toBe('Hello world');
  });

  it('accepts title and firstMessage together', () => {
    const result = createConversationRequestSchema.parse({
      title: 'My Chat',
      firstMessage: { content: 'Hello' },
    });
    expect(result.title).toBe('My Chat');
    expect(result.firstMessage?.content).toBe('Hello');
  });

  it('rejects firstMessage with empty content', () => {
    expect(() =>
      createConversationRequestSchema.parse({
        firstMessage: { content: '' },
      })
    ).toThrow();
  });
});

describe('updateConversationRequestSchema', () => {
  it('accepts valid title', () => {
    const result = updateConversationRequestSchema.parse({ title: 'New Title' });
    expect(result.title).toBe('New Title');
  });

  it('rejects empty title', () => {
    expect(() => updateConversationRequestSchema.parse({ title: '' })).toThrow();
  });

  it('rejects title exceeding max length', () => {
    const longTitle = 'a'.repeat(256);
    expect(() => updateConversationRequestSchema.parse({ title: longTitle })).toThrow();
  });

  it('accepts title at max length', () => {
    const maxTitle = 'a'.repeat(255);
    const result = updateConversationRequestSchema.parse({ title: maxTitle });
    expect(result.title).toBe(maxTitle);
  });

  it('rejects missing title', () => {
    expect(() => updateConversationRequestSchema.parse({})).toThrow();
  });
});

describe('createMessageRequestSchema', () => {
  it('accepts user role with content', () => {
    const result = createMessageRequestSchema.parse({
      role: 'user',
      content: 'Hello',
    });
    expect(result.role).toBe('user');
    expect(result.content).toBe('Hello');
    expect(result.model).toBeUndefined();
  });

  it('accepts assistant role with model', () => {
    const result = createMessageRequestSchema.parse({
      role: 'assistant',
      content: 'Hi there',
      model: 'gpt-4',
    });
    expect(result.role).toBe('assistant');
    expect(result.content).toBe('Hi there');
    expect(result.model).toBe('gpt-4');
  });

  it('accepts system role', () => {
    const result = createMessageRequestSchema.parse({
      role: 'system',
      content: 'You are a helpful assistant',
    });
    expect(result.role).toBe('system');
  });

  it('rejects invalid role', () => {
    expect(() =>
      createMessageRequestSchema.parse({
        role: 'invalid',
        content: 'Hello',
      })
    ).toThrow();
  });

  it('rejects empty content', () => {
    expect(() =>
      createMessageRequestSchema.parse({
        role: 'user',
        content: '',
      })
    ).toThrow();
  });

  it('rejects missing content', () => {
    expect(() =>
      createMessageRequestSchema.parse({
        role: 'user',
      })
    ).toThrow();
  });

  it('rejects missing role', () => {
    expect(() =>
      createMessageRequestSchema.parse({
        content: 'Hello',
      })
    ).toThrow();
  });
});

// ============================================================
// Response Schema Tests
// ============================================================

describe('conversationResponseSchema', () => {
  it('accepts valid conversation', () => {
    const result = conversationResponseSchema.parse({
      id: 'conv-123',
      userId: 'user-456',
      title: 'My Chat',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-02T00:00:00Z',
    });
    expect(result.id).toBe('conv-123');
    expect(result.userId).toBe('user-456');
    expect(result.title).toBe('My Chat');
  });

  it('rejects missing fields', () => {
    expect(() =>
      conversationResponseSchema.parse({
        id: 'conv-123',
      })
    ).toThrow();
  });
});

describe('messageResponseSchema', () => {
  it('accepts valid message with all fields', () => {
    const result = messageResponseSchema.parse({
      id: 'msg-123',
      conversationId: 'conv-456',
      role: 'user',
      content: 'Hello',
      model: 'gpt-4',
      createdAt: '2024-01-01T00:00:00Z',
    });
    expect(result.role).toBe('user');
    expect(result.model).toBe('gpt-4');
  });

  it('accepts message without model', () => {
    const result = messageResponseSchema.parse({
      id: 'msg-123',
      conversationId: 'conv-456',
      role: 'assistant',
      content: 'Hi there',
      createdAt: '2024-01-01T00:00:00Z',
    });
    expect(result.model).toBeUndefined();
  });

  it('accepts null model', () => {
    const result = messageResponseSchema.parse({
      id: 'msg-123',
      conversationId: 'conv-456',
      role: 'system',
      content: 'Instructions',
      model: null,
      createdAt: '2024-01-01T00:00:00Z',
    });
    expect(result.model).toBeNull();
  });
});

describe('listConversationsResponseSchema', () => {
  it('accepts empty conversations array', () => {
    const result = listConversationsResponseSchema.parse({ conversations: [] });
    expect(result.conversations).toEqual([]);
  });

  it('accepts array of conversations', () => {
    const result = listConversationsResponseSchema.parse({
      conversations: [
        {
          id: 'conv-1',
          userId: 'user-1',
          title: 'Chat 1',
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
        {
          id: 'conv-2',
          userId: 'user-1',
          title: 'Chat 2',
          createdAt: '2024-01-02T00:00:00Z',
          updatedAt: '2024-01-02T00:00:00Z',
        },
      ],
    });
    expect(result.conversations).toHaveLength(2);
  });
});

describe('getConversationResponseSchema', () => {
  it('accepts conversation with messages', () => {
    const result = getConversationResponseSchema.parse({
      conversation: {
        id: 'conv-123',
        userId: 'user-456',
        title: 'My Chat',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      },
      messages: [
        {
          id: 'msg-1',
          conversationId: 'conv-123',
          role: 'user',
          content: 'Hello',
          createdAt: '2024-01-01T00:00:00Z',
        },
      ],
    });
    expect(result.conversation.id).toBe('conv-123');
    expect(result.messages).toHaveLength(1);
  });

  it('accepts conversation with empty messages', () => {
    const result = getConversationResponseSchema.parse({
      conversation: {
        id: 'conv-123',
        userId: 'user-456',
        title: 'Empty Chat',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      },
      messages: [],
    });
    expect(result.messages).toEqual([]);
  });
});

describe('createConversationResponseSchema', () => {
  it('accepts conversation without message', () => {
    const result = createConversationResponseSchema.parse({
      conversation: {
        id: 'conv-123',
        userId: 'user-456',
        title: '',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      },
    });
    expect(result.conversation.id).toBe('conv-123');
    expect(result.message).toBeUndefined();
  });

  it('accepts conversation with message', () => {
    const result = createConversationResponseSchema.parse({
      conversation: {
        id: 'conv-123',
        userId: 'user-456',
        title: 'New Chat',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      },
      message: {
        id: 'msg-1',
        conversationId: 'conv-123',
        role: 'user',
        content: 'First message',
        createdAt: '2024-01-01T00:00:00Z',
      },
    });
    expect(result.message?.content).toBe('First message');
  });
});

describe('updateConversationResponseSchema', () => {
  it('accepts updated conversation', () => {
    const result = updateConversationResponseSchema.parse({
      conversation: {
        id: 'conv-123',
        userId: 'user-456',
        title: 'Updated Title',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-02T00:00:00Z',
      },
    });
    expect(result.conversation.title).toBe('Updated Title');
  });
});

describe('deleteConversationResponseSchema', () => {
  it('accepts deleted true', () => {
    const result = deleteConversationResponseSchema.parse({ deleted: true });
    expect(result.deleted).toBe(true);
  });

  it('accepts deleted false', () => {
    const result = deleteConversationResponseSchema.parse({ deleted: false });
    expect(result.deleted).toBe(false);
  });

  it('rejects missing deleted field', () => {
    expect(() => deleteConversationResponseSchema.parse({})).toThrow();
  });
});

describe('createMessageResponseSchema', () => {
  it('accepts valid message response', () => {
    const result = createMessageResponseSchema.parse({
      message: {
        id: 'msg-123',
        conversationId: 'conv-456',
        role: 'user',
        content: 'Hello AI',
        createdAt: '2024-01-01T00:00:00Z',
      },
    });
    expect(result.message.content).toBe('Hello AI');
  });
});
