import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseReasoningText, serializeReasoningText } from '@hushbox/shared';
import {
  createUserMessage,
  createAssistantMessage,
  createTrialMessage,
  appendTokenToMessage,
  type ChatErrorDisplay,
} from './chat-messages';

describe('chat-messages', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-15T10:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('createUserMessage', () => {
    it('creates a user message with correct structure', () => {
      const message = createUserMessage('conv-123', 'Hello world', undefined, null);

      expect(message).toMatchObject({
        conversationId: 'conv-123',
        role: 'user',
        content: 'Hello world',
        createdAt: '2024-01-15T10:00:00.000Z',
        parentMessageId: null,
      });
      expect(message.id).toBeDefined();
      expect(typeof message.id).toBe('string');
    });

    it('generates unique IDs for each message', () => {
      const message1 = createUserMessage('conv-123', 'First', undefined, null);
      const message2 = createUserMessage('conv-123', 'Second', undefined, null);

      expect(message1.id).not.toBe(message2.id);
    });

    it('includes senderId when provided', () => {
      const message = createUserMessage('conv-123', 'Hello', 'user-42', null);

      expect(message.senderId).toBe('user-42');
    });

    it('omits senderId when not provided', () => {
      const message = createUserMessage('conv-123', 'Hello', undefined, null);

      expect(message.senderId).toBeUndefined();
    });

    it('includes parentMessageId when provided', () => {
      const message = createUserMessage('conv-123', 'Hello', 'user-42', 'parent-msg-id');

      expect(message.parentMessageId).toBe('parent-msg-id');
    });

    it('sets parentMessageId to null when not provided', () => {
      const message = createUserMessage('conv-123', 'Hello', undefined, null);

      expect(message.parentMessageId).toBeNull();
    });
  });

  describe('createAssistantMessage', () => {
    it('creates an assistant message with empty content', () => {
      const message = createAssistantMessage('conv-456', 'assistant-msg-id', undefined, null);

      expect(message).toEqual({
        id: 'assistant-msg-id',
        conversationId: 'conv-456',
        role: 'assistant',
        content: '',
        createdAt: '2024-01-15T10:00:00.000Z',
        parentMessageId: null,
      });
    });

    it('uses the provided assistant message ID', () => {
      const message = createAssistantMessage('conv-789', 'custom-id-123', undefined, null);

      expect(message.id).toBe('custom-id-123');
    });

    it('includes modelName when provided', () => {
      const message = createAssistantMessage('conv-456', 'msg-id', 'GPT-4o', null);

      expect(message.modelName).toBe('GPT-4o');
    });

    it('omits modelName when not provided', () => {
      const message = createAssistantMessage('conv-456', 'msg-id', undefined, null);

      expect(message.modelName).toBeUndefined();
    });

    it('includes parentMessageId when provided', () => {
      const message = createAssistantMessage('conv-456', 'msg-id', 'GPT-4o', 'parent-msg-id');

      expect(message.parentMessageId).toBe('parent-msg-id');
    });

    it('sets parentMessageId to null when not provided', () => {
      const message = createAssistantMessage('conv-456', 'msg-id', undefined, null);

      expect(message.parentMessageId).toBeNull();
    });
  });

  describe('createTrialMessage', () => {
    it('creates a trial user message with generated ID', () => {
      const message = createTrialMessage('user', 'Hello from guest');

      expect(message).toMatchObject({
        conversationId: 'trial',
        role: 'user',
        content: 'Hello from guest',
        createdAt: '2024-01-15T10:00:00.000Z',
      });
      expect(message.id).toBeDefined();
    });

    it('creates a trial assistant message with provided ID', () => {
      const message = createTrialMessage('assistant', '', 'provided-id');

      expect(message).toEqual({
        id: 'provided-id',
        conversationId: 'trial',
        role: 'assistant',
        content: '',
        createdAt: '2024-01-15T10:00:00.000Z',
      });
    });

    it('generates ID when not provided', () => {
      const message1 = createTrialMessage('user', 'Test');
      const message2 = createTrialMessage('user', 'Test');

      expect(message1.id).not.toBe(message2.id);
    });

    it('includes modelName when provided', () => {
      const message = createTrialMessage('assistant', '', 'msg-id', 'smart-model');

      expect(message.modelName).toBe('smart-model');
    });

    it('omits modelName when not provided', () => {
      const message = createTrialMessage('assistant', '', 'msg-id');

      expect(message.modelName).toBeUndefined();
    });
  });

  describe('ChatErrorDisplay', () => {
    it('has the correct shape', () => {
      const errorDisplay: ChatErrorDisplay = {
        id: 'err-1',
        role: 'assistant',
        content: 'Error message',
        retryable: true,
        isError: true,
      };

      expect(errorDisplay.role).toBe('assistant');
      expect(errorDisplay.isError).toBe(true);
      expect(errorDisplay.retryable).toBe(true);
    });
  });

  describe('appendTokenToMessage', () => {
    it('appends token to the correct message', () => {
      const messages = [
        { id: 'msg-1', content: 'Hello' },
        { id: 'msg-2', content: 'World' },
      ];

      const result = appendTokenToMessage(messages, 'msg-1', ' there');

      expect(result).toEqual([
        { id: 'msg-1', content: 'Hello there' },
        { id: 'msg-2', content: 'World' },
      ]);
    });

    it('does not modify original array', () => {
      const messages = [{ id: 'msg-1', content: 'Original' }];

      appendTokenToMessage(messages, 'msg-1', ' suffix');

      expect(messages[0]?.content).toBe('Original');
    });

    it('returns unchanged array if message not found', () => {
      const messages = [{ id: 'msg-1', content: 'Hello' }];

      const result = appendTokenToMessage(messages, 'nonexistent', ' token');

      expect(result).toEqual(messages);
    });

    it('works with empty messages array', () => {
      const result = appendTokenToMessage([], 'msg-1', 'token');

      expect(result).toEqual([]);
    });

    it('handles multiple consecutive appends', () => {
      let messages = [{ id: 'msg-1', content: '' }];
      messages = appendTokenToMessage(messages, 'msg-1', 'Hello');
      messages = appendTokenToMessage(messages, 'msg-1', ' ');
      messages = appendTokenToMessage(messages, 'msg-1', 'World');

      expect(messages[0]?.content).toBe('Hello World');
    });

    it('embeds a reasoning-channel token so it parses back as reasoning', () => {
      const messages = [{ id: 'msg-1', content: '' }];

      const result = appendTokenToMessage(messages, 'msg-1', 'thinking', 'reasoning');

      expect(parseReasoningText(result[0]!.content)).toEqual({
        reasoning: 'thinking',
        answer: '',
      });
    });

    it('accumulates consecutive reasoning-channel tokens into one reasoning block', () => {
      let messages = [{ id: 'msg-1', content: '' }];
      messages = appendTokenToMessage(messages, 'msg-1', 'first ', 'reasoning');
      messages = appendTokenToMessage(messages, 'msg-1', 'second', 'reasoning');

      expect(parseReasoningText(messages[0]!.content)).toEqual({
        reasoning: 'first second',
        answer: '',
      });
    });

    it('keeps answer tokens after reasoning identical to the persisted serialization', () => {
      let messages = [{ id: 'msg-1', content: '' }];
      messages = appendTokenToMessage(messages, 'msg-1', 'why ', 'reasoning');
      messages = appendTokenToMessage(messages, 'msg-1', 'not', 'reasoning');
      messages = appendTokenToMessage(messages, 'msg-1', 'Hello');
      messages = appendTokenToMessage(messages, 'msg-1', ' there');

      expect(messages[0]!.content).toBe(serializeReasoningText('why not', 'Hello there'));
      expect(parseReasoningText(messages[0]!.content)).toEqual({
        reasoning: 'why not',
        answer: 'Hello there',
      });
    });

    it('keeps an existing answer when a late reasoning-channel token arrives', () => {
      let messages = [{ id: 'msg-1', content: 'partial answer' }];
      messages = appendTokenToMessage(messages, 'msg-1', 'late thought', 'reasoning');

      expect(parseReasoningText(messages[0]!.content)).toEqual({
        reasoning: 'late thought',
        answer: 'partial answer',
      });
    });
  });
});
