import { create } from 'zustand';

import { appendTokenToMessage } from '@/lib/chat-messages';
import type { StreamTokenChannel } from '@/lib/chat-messages';
import type { StageDonePayload } from '@hushbox/shared';

export interface TrialMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  modelName?: string;
  /**
   * Real model name resolved by a pre-inference stage (Smart Model classifier),
   * delivered out-of-band via `stage:done`. Used as the nametag's immediate
   * display value, mirroring the authenticated message shape.
   */
  resolvedModelName?: string;
  isSmartModel?: boolean;
}

interface TrialChatState {
  /** All trial messages in the current session */
  messages: TrialMessage[];
  /** The first message that triggered navigation to /chat/trial */
  pendingMessage: string | null;
  /** Whether the user has hit the rate limit */
  isRateLimited: boolean;
  /** Add a message to the conversation */
  addMessage: (message: TrialMessage) => void;
  /** Update a message's content (for streaming) */
  updateMessageContent: (messageId: string, content: string) => void;
  /**
   * Append one streamed delta to a message. Reasoning-channel tokens fold
   * into the canonical inline format via the shared parser/serializer (the
   * same accumulation the authenticated optimistic path uses), so a trial
   * message parses identically at every step.
   */
  appendToMessage: (messageId: string, token: string, channel?: StreamTokenChannel) => void;
  /** Record a pre-inference stage's resolved model on a message (Smart Model). */
  setMessageStageDone: (messageId: string, payload: StageDonePayload) => void;
  /** Set the pending first message */
  setPendingMessage: (message: string | null) => void;
  /** Clear the pending message */
  clearPendingMessage: () => void;
  /** Set rate limited state */
  setRateLimited: (limited: boolean) => void;
  /** Remove all messages after the given message ID (keeps the target) */
  removeMessagesAfter: (messageId: string) => void;
  /** Drop a single message by id; no-op if not present */
  removeMessage: (messageId: string) => void;
  /** Clear all trial messages and reset state */
  reset: () => void;
}

export const useTrialChatStore = create<TrialChatState>((set) => ({
  messages: [],
  pendingMessage: null,
  isRateLimited: false,
  addMessage: (message) => {
    set((state) => ({ messages: [...state.messages, message] }));
  },
  updateMessageContent: (messageId, content) => {
    set((state) => ({
      messages: state.messages.map((m) => (m.id === messageId ? { ...m, content } : m)),
    }));
  },
  appendToMessage: (messageId, token, channel = 'answer') => {
    set((state) => ({
      messages: appendTokenToMessage(state.messages, messageId, token, channel),
    }));
  },
  setMessageStageDone: (messageId, payload) => {
    set((state) => ({
      messages: state.messages.map((m) =>
        m.id === messageId
          ? {
              ...m,
              // Record the resolved id (so the nametag resolves like an authed
              // message) and the resolved name (immediate display fallback).
              modelName: payload.resolvedModelId,
              resolvedModelName: payload.resolvedModelName,
              // Cast to string widens away from today's single-literal StageId
              // union so this reads as forward-compat against future stages.
              ...((payload.stageId as string) === 'smart-model' && { isSmartModel: true }),
            }
          : m
      ),
    }));
  },
  setPendingMessage: (message) => {
    set({ pendingMessage: message });
  },
  clearPendingMessage: () => {
    set({ pendingMessage: null });
  },
  setRateLimited: (limited) => {
    set({ isRateLimited: limited });
  },
  removeMessagesAfter: (messageId) => {
    set((state) => {
      const index = state.messages.findIndex((m) => m.id === messageId);
      if (index === -1) return state;
      return { messages: state.messages.slice(0, index + 1) };
    });
  },
  removeMessage: (messageId) => {
    set((state) => ({ messages: state.messages.filter((m) => m.id !== messageId) }));
  },
  reset: () => {
    set({ messages: [], pendingMessage: null, isRateLimited: false });
  },
}));
