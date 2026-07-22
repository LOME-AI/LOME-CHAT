import { parseReasoningText, serializeReasoningText } from '@hushbox/shared';
import type { Message } from '@/lib/api';
import type { TrialMessage } from '@/stores/trial-chat';

export function createUserMessage(
  conversationId: string,
  content: string,
  senderId: string | undefined,
  parentMessageId: string | null
): Message {
  return {
    id: crypto.randomUUID(),
    conversationId,
    role: 'user',
    content,
    createdAt: new Date().toISOString(),
    ...(senderId !== undefined && { senderId }),
    parentMessageId,
  };
}

export function createAssistantMessage(
  conversationId: string,
  assistantMessageId: string,
  modelName: string | undefined,
  parentMessageId: string | null
): Message {
  return {
    id: assistantMessageId,
    conversationId,
    role: 'assistant',
    content: '',
    createdAt: new Date().toISOString(),
    ...(modelName !== undefined && { modelName }),
    parentMessageId,
  };
}

export function createTrialMessage(
  role: 'user' | 'assistant',
  content: string,
  id?: string,
  modelName?: string
): TrialMessage {
  return {
    id: id ?? crypto.randomUUID(),
    conversationId: 'trial',
    role,
    content,
    createdAt: new Date().toISOString(),
    ...(modelName !== undefined && { modelName }),
  };
}

export interface ChatErrorDisplay {
  id: string;
  role: 'assistant';
  content: string;
  retryable: boolean;
  isError: true;
}

export type StreamTokenChannel = 'answer' | 'reasoning';

/**
 * Appends one streamed delta to a message's single text field. Answer tokens
 * concatenate verbatim (never rewriting received bytes — a model natively
 * emitting reasoning delimiters in its text passes through untouched);
 * reasoning tokens are folded into the canonical inline reasoning format via
 * the shared parser/serializer, so a live message parses identically to its
 * persisted serialization at every step.
 */
export function appendTokenToMessage<T extends { id: string; content: string }>(
  messages: T[],
  messageId: string,
  token: string,
  channel: StreamTokenChannel = 'answer'
): T[] {
  return messages.map((m) =>
    m.id === messageId ? { ...m, content: appendStreamedToken(m.content, token, channel) } : m
  );
}

function appendStreamedToken(content: string, token: string, channel: StreamTokenChannel): string {
  if (channel === 'answer') {
    return content + token;
  }
  const { reasoning, answer } = parseReasoningText(content);
  return serializeReasoningText((reasoning ?? '') + token, answer);
}
