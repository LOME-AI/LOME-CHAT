import { create } from 'zustand';

interface PendingMessage {
  id: string;
  content: string;
  createdAt: Date;
}

interface ChatState {
  pendingMessages: Map<string, PendingMessage[]>;
  addPendingMessage: (conversationId: string, content: string) => string;
  removePendingMessage: (conversationId: string, id: string) => void;
  clearPendingMessages: (conversationId: string) => void;

  streamingContent: string | null;
  setStreamingContent: (content: string | null) => void;
  appendStreamingContent: (chunk: string) => void;
}

export const useChatStore = create<ChatState>()((set) => ({
  pendingMessages: new Map(),

  addPendingMessage: (conversationId, content) => {
    const id = crypto.randomUUID();
    const message: PendingMessage = { id, content, createdAt: new Date() };
    set((state) => {
      const newMap = new Map(state.pendingMessages);
      const existing = newMap.get(conversationId) ?? [];
      newMap.set(conversationId, [...existing, message]);
      return { pendingMessages: newMap };
    });
    return id;
  },

  removePendingMessage: (conversationId, id) => {
    set((state) => {
      const newMap = new Map(state.pendingMessages);
      const existing = newMap.get(conversationId) ?? [];
      newMap.set(
        conversationId,
        existing.filter((m) => m.id !== id)
      );
      return { pendingMessages: newMap };
    });
  },

  clearPendingMessages: (conversationId) => {
    set((state) => {
      const newMap = new Map(state.pendingMessages);
      newMap.delete(conversationId);
      return { pendingMessages: newMap };
    });
  },

  streamingContent: null,
  setStreamingContent: (content) => {
    set({ streamingContent: content });
  },
  appendStreamingContent: (chunk) => {
    set((state) => ({
      streamingContent: (state.streamingContent ?? '') + chunk,
    }));
  },
}));
