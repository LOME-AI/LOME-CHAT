import { beforeEach, describe, expect, it } from 'vitest';
import { useChatStore } from './chat';

describe('useChatStore', () => {
  beforeEach(() => {
    // Reset store state before each test
    useChatStore.setState({
      pendingMessages: new Map(),
      streamingContent: null,
    });
  });

  describe('initial state', () => {
    it('has empty pending messages map', () => {
      const state = useChatStore.getState();
      expect(state.pendingMessages.size).toBe(0);
    });

    it('has null streaming content', () => {
      const state = useChatStore.getState();
      expect(state.streamingContent).toBeNull();
    });
  });

  describe('addPendingMessage', () => {
    it('adds a pending message to a conversation', () => {
      const { addPendingMessage } = useChatStore.getState();
      const conversationId = 'conv-123';
      const content = 'Hello, world!';

      const messageId = addPendingMessage(conversationId, content);

      expect(messageId).toBeDefined();
      expect(typeof messageId).toBe('string');

      const messages = useChatStore.getState().pendingMessages.get(conversationId);
      expect(messages).toBeDefined();
      expect(messages).toHaveLength(1);

      const firstMessage = messages?.[0];
      expect(firstMessage?.content).toBe(content);
      expect(firstMessage?.id).toBe(messageId);
      expect(firstMessage?.createdAt).toBeInstanceOf(Date);
    });

    it('adds multiple messages to the same conversation', () => {
      const { addPendingMessage } = useChatStore.getState();
      const conversationId = 'conv-123';

      addPendingMessage(conversationId, 'First message');
      addPendingMessage(conversationId, 'Second message');

      const messages = useChatStore.getState().pendingMessages.get(conversationId);
      expect(messages).toHaveLength(2);
      expect(messages?.[0]?.content).toBe('First message');
      expect(messages?.[1]?.content).toBe('Second message');
    });

    it('keeps messages separate between conversations', () => {
      const { addPendingMessage } = useChatStore.getState();

      addPendingMessage('conv-1', 'Message for conv 1');
      addPendingMessage('conv-2', 'Message for conv 2');

      const { pendingMessages } = useChatStore.getState();
      expect(pendingMessages.get('conv-1')).toHaveLength(1);
      expect(pendingMessages.get('conv-2')).toHaveLength(1);
      expect(pendingMessages.get('conv-1')?.[0]?.content).toBe('Message for conv 1');
      expect(pendingMessages.get('conv-2')?.[0]?.content).toBe('Message for conv 2');
    });
  });

  describe('removePendingMessage', () => {
    it('removes a specific pending message', () => {
      const { addPendingMessage, removePendingMessage } = useChatStore.getState();
      const conversationId = 'conv-123';

      const id1 = addPendingMessage(conversationId, 'First');
      addPendingMessage(conversationId, 'Second');

      removePendingMessage(conversationId, id1);

      const messages = useChatStore.getState().pendingMessages.get(conversationId);
      expect(messages).toHaveLength(1);
      expect(messages?.[0]?.content).toBe('Second');
    });

    it('handles removing from non-existent conversation gracefully', () => {
      const { removePendingMessage } = useChatStore.getState();

      // Should not throw
      expect(() => {
        removePendingMessage('non-existent', 'some-id');
      }).not.toThrow();
    });
  });

  describe('clearPendingMessages', () => {
    it('clears all pending messages for a conversation', () => {
      const { addPendingMessage, clearPendingMessages } = useChatStore.getState();
      const conversationId = 'conv-123';

      addPendingMessage(conversationId, 'First');
      addPendingMessage(conversationId, 'Second');

      clearPendingMessages(conversationId);

      const { pendingMessages } = useChatStore.getState();
      expect(pendingMessages.has(conversationId)).toBe(false);
    });

    it('does not affect other conversations', () => {
      const { addPendingMessage, clearPendingMessages } = useChatStore.getState();

      addPendingMessage('conv-1', 'Keep this');
      addPendingMessage('conv-2', 'Clear this');

      clearPendingMessages('conv-2');

      const { pendingMessages } = useChatStore.getState();
      expect(pendingMessages.get('conv-1')).toHaveLength(1);
      expect(pendingMessages.has('conv-2')).toBe(false);
    });
  });

  describe('setStreamingContent', () => {
    it('sets streaming content', () => {
      const { setStreamingContent } = useChatStore.getState();
      setStreamingContent('Hello');
      expect(useChatStore.getState().streamingContent).toBe('Hello');
    });

    it('clears streaming content when set to null', () => {
      useChatStore.setState({ streamingContent: 'Some content' });
      const { setStreamingContent } = useChatStore.getState();
      setStreamingContent(null);
      expect(useChatStore.getState().streamingContent).toBeNull();
    });
  });

  describe('appendStreamingContent', () => {
    it('appends to existing streaming content', () => {
      useChatStore.setState({ streamingContent: 'Hello' });
      const { appendStreamingContent } = useChatStore.getState();
      appendStreamingContent(' World');
      expect(useChatStore.getState().streamingContent).toBe('Hello World');
    });

    it('starts from empty string when streaming content is null', () => {
      const { appendStreamingContent } = useChatStore.getState();
      appendStreamingContent('First chunk');
      expect(useChatStore.getState().streamingContent).toBe('First chunk');
    });
  });
});
