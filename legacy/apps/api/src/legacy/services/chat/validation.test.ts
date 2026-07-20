import { describe, it, expect } from 'vitest';
import { validateLastMessageIsFromUser, buildAIMessages } from './validation.js';

describe('validateLastMessageIsFromUser', () => {
  it('returns true when last message role is user', () => {
    const messages = [
      { role: 'assistant', content: 'Hello' },
      { role: 'user', content: 'Hi there' },
    ];
    expect(validateLastMessageIsFromUser(messages)).toBe(true);
  });

  it('returns false when last message role is assistant', () => {
    const messages = [
      { role: 'user', content: 'Hi there' },
      { role: 'assistant', content: 'Hello' },
    ];
    expect(validateLastMessageIsFromUser(messages)).toBe(false);
  });

  it('returns false when last message role is system', () => {
    const messages = [
      { role: 'user', content: 'Hi there' },
      { role: 'system', content: 'You are helpful' },
    ];
    expect(validateLastMessageIsFromUser(messages)).toBe(false);
  });

  it('returns true for single user message', () => {
    const messages = [{ role: 'user', content: 'Hello' }];
    expect(validateLastMessageIsFromUser(messages)).toBe(true);
  });

  it('returns false for empty messages array', () => {
    expect(validateLastMessageIsFromUser([])).toBe(false);
  });
});

describe('buildAIMessages', () => {
  it('prepends system prompt to messages', () => {
    const messages = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
    ];
    const systemPrompt = 'You are a helpful assistant';

    const result = buildAIMessages(systemPrompt, messages);

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ role: 'system', content: 'You are a helpful assistant' });
    expect(result[1]).toEqual({ role: 'user', content: 'Hello' });
    expect(result[2]).toEqual({ role: 'assistant', content: 'Hi' });
  });

  it('handles empty messages array', () => {
    const result = buildAIMessages('System prompt', []);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ role: 'system', content: 'System prompt' });
  });

  it('maps message roles correctly', () => {
    const messages = [
      { role: 'user', content: 'User message' },
      { role: 'assistant', content: 'Assistant message' },
      { role: 'system', content: 'System message' },
    ];

    const result = buildAIMessages('Prompt', messages);

    expect(result).toHaveLength(4);
    expect(result[1]?.role).toBe('user');
    expect(result[2]?.role).toBe('assistant');
    expect(result[3]?.role).toBe('system');
  });

  it('preserves message content exactly', () => {
    const content = 'Message with special chars: <>&"\'';
    const messages = [{ role: 'user', content }];

    const result = buildAIMessages('Prompt', messages);

    expect(result[1]?.content).toBe(content);
  });

  it('does not include extra properties from source messages', () => {
    const messages = [{ role: 'user', content: 'Hello', id: 'msg-1', createdAt: new Date() }];

    const result = buildAIMessages('Prompt', messages);

    // Should only have role and content
    expect(Object.keys(result[1] as object)).toEqual(['role', 'content']);
  });
});
