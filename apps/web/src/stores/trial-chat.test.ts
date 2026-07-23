import { describe, it, expect, beforeEach } from 'vitest';
import { parseReasoningText } from '@hushbox/shared';
import { useTrialChatStore } from './trial-chat';
import type { TrialMessage } from './trial-chat';

function makeTrialMessage(id: string, role: 'user' | 'assistant', content: string): TrialMessage {
  return { id, conversationId: 'trial', role, content, createdAt: '' };
}

describe('useTrialChatStore', () => {
  beforeEach(() => {
    useTrialChatStore.getState().reset();
  });

  it('starts with empty messages', () => {
    expect(useTrialChatStore.getState().messages).toEqual([]);
  });

  it('starts with no pending message', () => {
    expect(useTrialChatStore.getState().pendingMessage).toBeNull();
  });

  it('starts not rate limited', () => {
    expect(useTrialChatStore.getState().isRateLimited).toBe(false);
  });

  describe('addMessage', () => {
    it('appends a message', () => {
      const msg = makeTrialMessage('m1', 'user', 'Hello');

      useTrialChatStore.getState().addMessage(msg);

      expect(useTrialChatStore.getState().messages).toEqual([msg]);
    });

    it('appends multiple messages in order', () => {
      const m1 = makeTrialMessage('m1', 'user', 'Hello');
      const m2 = makeTrialMessage('m2', 'assistant', 'Hi');

      useTrialChatStore.getState().addMessage(m1);
      useTrialChatStore.getState().addMessage(m2);

      expect(useTrialChatStore.getState().messages).toEqual([m1, m2]);
    });
  });

  describe('updateMessageContent', () => {
    it('replaces content of the target message', () => {
      const msg = makeTrialMessage('m1', 'assistant', 'partial');
      useTrialChatStore.getState().addMessage(msg);

      useTrialChatStore.getState().updateMessageContent('m1', 'complete response');

      expect(useTrialChatStore.getState().messages[0]!.content).toBe('complete response');
    });

    it('does not affect other messages', () => {
      useTrialChatStore.getState().addMessage(makeTrialMessage('m1', 'user', 'Hello'));
      useTrialChatStore.getState().addMessage(makeTrialMessage('m2', 'assistant', 'Hi'));

      useTrialChatStore.getState().updateMessageContent('m2', 'Updated');

      expect(useTrialChatStore.getState().messages[0]!.content).toBe('Hello');
      expect(useTrialChatStore.getState().messages[1]!.content).toBe('Updated');
    });
  });

  describe('appendToMessage', () => {
    it('appends token to message content', () => {
      useTrialChatStore.getState().addMessage(makeTrialMessage('m1', 'assistant', 'Hello'));

      useTrialChatStore.getState().appendToMessage('m1', ' world');

      expect(useTrialChatStore.getState().messages[0]!.content).toBe('Hello world');
    });

    it('leaves non-matching messages untouched when appending', () => {
      useTrialChatStore.getState().addMessage(makeTrialMessage('m1', 'user', 'Hello'));
      useTrialChatStore.getState().addMessage(makeTrialMessage('m2', 'assistant', 'Hi'));

      useTrialChatStore.getState().appendToMessage('m2', ' there');

      expect(useTrialChatStore.getState().messages[0]!.content).toBe('Hello');
      expect(useTrialChatStore.getState().messages[1]!.content).toBe('Hi there');
    });

    it('folds reasoning-channel tokens into the canonical inline format', () => {
      useTrialChatStore.getState().addMessage(makeTrialMessage('m1', 'assistant', ''));

      useTrialChatStore.getState().appendToMessage('m1', 'thinking ', 'reasoning');
      useTrialChatStore.getState().appendToMessage('m1', 'hard', 'reasoning');

      const parsed = parseReasoningText(useTrialChatStore.getState().messages[0]!.content);
      expect(parsed.reasoning).toBe('thinking hard');
      expect(parsed.answer).toBe('');
    });

    it('keeps the answer separate from accumulated reasoning', () => {
      useTrialChatStore.getState().addMessage(makeTrialMessage('m1', 'assistant', ''));

      useTrialChatStore.getState().appendToMessage('m1', 'a thought', 'reasoning');
      useTrialChatStore.getState().appendToMessage('m1', 'Echo: hi');

      const parsed = parseReasoningText(useTrialChatStore.getState().messages[0]!.content);
      expect(parsed.reasoning).toBe('a thought');
      expect(parsed.answer).toBe('Echo: hi');
    });
  });

  describe('setMessageStageDone', () => {
    it('records the resolved model id and name on the target message', () => {
      useTrialChatStore
        .getState()
        .addMessage({ ...makeTrialMessage('m1', 'assistant', ''), modelName: 'smart-model' });

      useTrialChatStore.getState().setMessageStageDone('m1', {
        stageId: 'smart-model',
        resolvedModelId: 'openai/gpt-4o-mini',
        resolvedModelName: 'GPT-4o mini',
      });

      const msg = useTrialChatStore.getState().messages[0]!;
      expect(msg.modelName).toBe('openai/gpt-4o-mini');
      expect(msg.resolvedModelName).toBe('GPT-4o mini');
      expect(msg.isSmartModel).toBe(true);
    });

    it('does not affect other messages', () => {
      useTrialChatStore.getState().addMessage(makeTrialMessage('m1', 'user', 'Hello'));
      useTrialChatStore
        .getState()
        .addMessage({ ...makeTrialMessage('m2', 'assistant', ''), modelName: 'smart-model' });

      useTrialChatStore.getState().setMessageStageDone('m2', {
        stageId: 'smart-model',
        resolvedModelId: 'openai/gpt-4o-mini',
        resolvedModelName: 'GPT-4o mini',
      });

      expect(useTrialChatStore.getState().messages[0]!.modelName).toBeUndefined();
      expect(useTrialChatStore.getState().messages[0]!.resolvedModelName).toBeUndefined();
    });
  });

  describe('pendingMessage', () => {
    it('sets pending message', () => {
      useTrialChatStore.getState().setPendingMessage('Hello');

      expect(useTrialChatStore.getState().pendingMessage).toBe('Hello');
    });

    it('clears pending message', () => {
      useTrialChatStore.getState().setPendingMessage('Hello');
      useTrialChatStore.getState().clearPendingMessage();

      expect(useTrialChatStore.getState().pendingMessage).toBeNull();
    });
  });

  describe('setRateLimited', () => {
    it('sets rate limited flag', () => {
      useTrialChatStore.getState().setRateLimited(true);

      expect(useTrialChatStore.getState().isRateLimited).toBe(true);
    });

    it('clears rate limited flag', () => {
      useTrialChatStore.getState().setRateLimited(true);
      useTrialChatStore.getState().setRateLimited(false);

      expect(useTrialChatStore.getState().isRateLimited).toBe(false);
    });
  });

  describe('reset', () => {
    it('clears all state', () => {
      useTrialChatStore.getState().addMessage(makeTrialMessage('m1', 'user', 'Hi'));
      useTrialChatStore.getState().setPendingMessage('pending');
      useTrialChatStore.getState().setRateLimited(true);

      useTrialChatStore.getState().reset();

      expect(useTrialChatStore.getState().messages).toEqual([]);
      expect(useTrialChatStore.getState().pendingMessage).toBeNull();
      expect(useTrialChatStore.getState().isRateLimited).toBe(false);
    });
  });

  describe('removeMessagesAfter', () => {
    it('keeps messages up to and including the target', () => {
      useTrialChatStore.getState().addMessage(makeTrialMessage('m1', 'user', 'Hello'));
      useTrialChatStore.getState().addMessage(makeTrialMessage('m2', 'assistant', 'Hi'));
      useTrialChatStore.getState().addMessage(makeTrialMessage('m3', 'user', 'Follow up'));
      useTrialChatStore.getState().addMessage(makeTrialMessage('m4', 'assistant', 'Response'));

      useTrialChatStore.getState().removeMessagesAfter('m2');

      const messages = useTrialChatStore.getState().messages;
      expect(messages).toHaveLength(2);
      expect(messages[0]!.id).toBe('m1');
      expect(messages[1]!.id).toBe('m2');
    });

    it('removes nothing when target is the last message', () => {
      useTrialChatStore.getState().addMessage(makeTrialMessage('m1', 'user', 'Hello'));
      useTrialChatStore.getState().addMessage(makeTrialMessage('m2', 'assistant', 'Hi'));

      useTrialChatStore.getState().removeMessagesAfter('m2');

      expect(useTrialChatStore.getState().messages).toHaveLength(2);
    });

    it('keeps all messages when target id is not found', () => {
      useTrialChatStore.getState().addMessage(makeTrialMessage('m1', 'user', 'Hello'));
      useTrialChatStore.getState().addMessage(makeTrialMessage('m2', 'assistant', 'Hi'));

      useTrialChatStore.getState().removeMessagesAfter('nonexistent');

      expect(useTrialChatStore.getState().messages).toHaveLength(2);
    });

    it('keeps only the first message when target is the first', () => {
      useTrialChatStore.getState().addMessage(makeTrialMessage('m1', 'user', 'Hello'));
      useTrialChatStore.getState().addMessage(makeTrialMessage('m2', 'assistant', 'Hi'));
      useTrialChatStore.getState().addMessage(makeTrialMessage('m3', 'user', 'More'));

      useTrialChatStore.getState().removeMessagesAfter('m1');

      const messages = useTrialChatStore.getState().messages;
      expect(messages).toHaveLength(1);
      expect(messages[0]!.id).toBe('m1');
    });
  });

  describe('removeMessage', () => {
    it('drops the message with the given id', () => {
      useTrialChatStore.getState().addMessage(makeTrialMessage('m1', 'user', 'Hello'));
      useTrialChatStore.getState().addMessage(makeTrialMessage('m2', 'assistant', ''));
      useTrialChatStore.getState().addMessage(makeTrialMessage('m3', 'user', 'Next'));

      useTrialChatStore.getState().removeMessage('m2');

      const messages = useTrialChatStore.getState().messages;
      expect(messages.map((m) => m.id)).toEqual(['m1', 'm3']);
    });

    it('is a no-op when the id is not present', () => {
      useTrialChatStore.getState().addMessage(makeTrialMessage('m1', 'user', 'Hello'));

      useTrialChatStore.getState().removeMessage('nonexistent');

      expect(useTrialChatStore.getState().messages.map((m) => m.id)).toEqual(['m1']);
    });
  });
});
