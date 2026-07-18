import { create } from 'zustand';

/**
 * A message the user composed while an AI run was streaming, held client-side
 * until the queue is drained one at a time. Persistence across navigation is
 * intended — the store never auto-clears; a later task decides when it does.
 */
export interface QueuedMessage {
  id: string;
  text: string;
}

const MAX_QUEUED_PER_CONVERSATION = 5;

interface MessageQueueState {
  queuesByConversation: Record<string, QueuedMessage[]>;
  enqueue: (conversationId: string, text: string) => boolean;
  cancel: (conversationId: string, id: string) => void;
  dequeueHead: (conversationId: string) => QueuedMessage | undefined;
  clear: (conversationId: string) => void;
  queued: (conversationId: string) => QueuedMessage[];
  count: (conversationId: string) => number;
  isFull: (conversationId: string) => boolean;
}

export const useMessageQueueStore = create<MessageQueueState>()((set, get) => ({
  queuesByConversation: {},

  enqueue: (conversationId, text) => {
    const current = get().queuesByConversation[conversationId] ?? [];
    if (current.length >= MAX_QUEUED_PER_CONVERSATION) return false;
    const message: QueuedMessage = { id: crypto.randomUUID(), text };
    set((state) => ({
      queuesByConversation: {
        ...state.queuesByConversation,
        [conversationId]: [...(state.queuesByConversation[conversationId] ?? []), message],
      },
    }));
    return true;
  },

  cancel: (conversationId, id) => {
    set((state) => {
      const current = state.queuesByConversation[conversationId];
      if (!current) return state;
      const next = current.filter((message) => message.id !== id);
      if (next.length === current.length) return state;
      return {
        queuesByConversation: { ...state.queuesByConversation, [conversationId]: next },
      };
    });
  },

  dequeueHead: (conversationId) => {
    const current = get().queuesByConversation[conversationId] ?? [];
    if (current.length === 0) return;
    const [head, ...rest] = current;
    set((state) => ({
      queuesByConversation: { ...state.queuesByConversation, [conversationId]: rest },
    }));
    return head;
  },

  clear: (conversationId) => {
    set((state) => ({
      queuesByConversation: { ...state.queuesByConversation, [conversationId]: [] },
    }));
  },

  queued: (conversationId) => get().queuesByConversation[conversationId] ?? [],

  count: (conversationId) => (get().queuesByConversation[conversationId] ?? []).length,

  isFull: (conversationId) =>
    (get().queuesByConversation[conversationId] ?? []).length >= MAX_QUEUED_PER_CONVERSATION,
}));
