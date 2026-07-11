import { useState, useEffect, useReducer } from 'react';
import {
  acquireConversationSocket,
  releaseConversationSocket,
} from '@/lib/conversation-socket-registry.js';
import type { ConversationWebSocket } from '@/lib/ws-client.js';

/**
 * Shares the conversation's socket through the refcounted registry: the chat
 * transport streams the local run over the SAME socket this hook exposes to
 * the realtime hooks (presence, remote streams, sync), so a group
 * conversation never holds two upgrades.
 */
export function useConversationWebSocket(
  conversationId: string | null
): ConversationWebSocket | null {
  const [ws, setWs] = useState<ConversationWebSocket | null>(null);
  const [, rerender] = useReducer((c: number) => c + 1, 0);

  useEffect(() => {
    if (!conversationId) {
      setWs(null);
      return;
    }

    const socket = acquireConversationSocket(conversationId);
    const unsubscribe = socket.onStateChange(rerender);
    setWs(socket);

    return (): void => {
      unsubscribe();
      releaseConversationSocket(conversationId);
    };
  }, [conversationId, rerender]);

  return ws;
}
