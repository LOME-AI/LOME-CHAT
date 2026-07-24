import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { chatKeys } from '@/hooks/chat/chat.js';
import { keyKeys } from '@/hooks/crypto/keys.js';
import { memberKeys } from '@/hooks/realtime/use-conversation-members.js';
import { budgetKeys } from '@/hooks/billing/use-conversation-budgets.js';
import { billingKeys } from '@/hooks/billing/billing.js';
import type { ConversationWebSocket } from '@/lib/ws-client.js';

export function useRealtimeSync(
  ws: ConversationWebSocket | null,
  conversationId: string | null,
  currentUserId: string | null
): void {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  // Catch-up refetch on every WS-ready transition: the DO retains only
  // live sockets so events broadcast during a disconnect are lost. Without
  // this, a missed `message:complete` leaves the client on stale state
  // until manual nav. The money keys (spendable, budgets, balance) are
  // included because a run-started/run-finished frame missed during the
  // disconnect is exactly a missed hold/settlement — the served affordability
  // numbers must not stay stale past reconnect. Initial-mount fires one
  // redundant refetch.
  const wsReady = ws?.ready ?? false;
  React.useEffect(() => {
    if (!wsReady || !conversationId) return;
    void queryClient.invalidateQueries({
      queryKey: chatKeys.conversation(conversationId),
    });
    void queryClient.invalidateQueries({
      queryKey: memberKeys.list(conversationId),
    });
    void queryClient.invalidateQueries({
      queryKey: billingKeys.spendable(),
    });
    void queryClient.invalidateQueries({
      queryKey: budgetKeys.conversation(conversationId),
    });
    void queryClient.invalidateQueries({
      queryKey: billingKeys.balance(),
    });
  }, [wsReady, conversationId, queryClient]);

  React.useEffect(() => {
    if (!ws || !conversationId) return;

    // The run protocol replaced the legacy message:new / message:stream /
    // message:complete broadcasts. Both run boundaries refresh the served
    // affordability numbers: run-started means a hold just landed (spendable
    // and hold-aware budget remaining shrank), run-finished is the settlement
    // signal (charge posted, hold released). run-finished additionally
    // refetches messages — billed cost renders only from persisted data.
    const unsubscribeRunFrames = ws.onRunFrame((frame) => {
      if (frame.type !== 'run-started' && frame.type !== 'run-finished') return;
      if (frame.type === 'run-finished') {
        void queryClient.invalidateQueries({
          queryKey: chatKeys.conversation(conversationId),
        });
      }
      void queryClient.invalidateQueries({
        queryKey: billingKeys.spendable(),
      });
      void queryClient.invalidateQueries({
        queryKey: budgetKeys.conversation(conversationId),
      });
      void queryClient.invalidateQueries({
        queryKey: billingKeys.balance(),
      });
    });

    const unsubscribes = [
      unsubscribeRunFrames,
      // The rebuilt backend does not broadcast message:new (runs carry their
      // own frames), but the demo's group-transcript replay still emits it —
      // keep the refetch so replayed messages appear as they arrive.
      ws.on('message:new', (event) => {
        if (currentUserId != null && event.senderId === currentUserId) return;
        void queryClient.invalidateQueries({
          queryKey: chatKeys.conversation(conversationId),
        });
      }),
      ws.on('member:added', () => {
        void queryClient.invalidateQueries({
          queryKey: memberKeys.list(conversationId),
        });
        void queryClient.invalidateQueries({
          queryKey: budgetKeys.conversation(conversationId),
        });
      }),
      ws.on('member:removed', (event) => {
        void queryClient.invalidateQueries({
          queryKey: memberKeys.list(conversationId),
        });
        void queryClient.invalidateQueries({
          queryKey: budgetKeys.conversation(conversationId),
        });
        void queryClient.invalidateQueries({
          queryKey: chatKeys.conversations(),
        });
        if (currentUserId != null && event.userId === currentUserId) {
          void navigate({ to: '/chat' });
        }
      }),
      ws.on('member:privilege-changed', () => {
        void queryClient.invalidateQueries({
          queryKey: memberKeys.list(conversationId),
        });
        void queryClient.invalidateQueries({
          queryKey: budgetKeys.conversation(conversationId),
        });
      }),
      ws.on('rotation:complete', () => {
        void queryClient.invalidateQueries({
          queryKey: keyKeys.chain(conversationId),
        });
        void queryClient.invalidateQueries({
          queryKey: chatKeys.conversation(conversationId),
        });
      }),
    ];

    return (): void => {
      for (const unsub of unsubscribes) {
        unsub();
      }
    };
  }, [ws, conversationId, currentUserId, queryClient, navigate]);
}
