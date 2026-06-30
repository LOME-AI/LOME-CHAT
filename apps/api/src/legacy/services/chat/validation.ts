import type { AIMessage } from '../ai/index.js';

interface MessageWithRole {
  role: string;
  content: string;
}

/**
 * Validates that the last message in an array is from a user.
 * Returns false for empty arrays or when last message is not from user.
 */
export function validateLastMessageIsFromUser(messages: MessageWithRole[]): boolean {
  if (messages.length === 0) {
    return false;
  }
  const lastMessage = messages.at(-1);
  return lastMessage?.role === 'user';
}

/**
 * Builds an AIMessage array with system prompt prepended.
 * Maps messages to role/content pairs for the AIClient.
 */
export function buildAIMessages(systemPrompt: string, messages: MessageWithRole[]): AIMessage[] {
  return [
    { role: 'system' as const, content: systemPrompt },
    ...messages.map((msg) => ({
      role: msg.role as AIMessage['role'],
      content: msg.content,
    })),
  ];
}
