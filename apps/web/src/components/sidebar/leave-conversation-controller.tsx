import * as React from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ROUTES } from '@hushbox/shared';
import { useLeaveConversation } from '@/hooks/realtime/use-conversation-members';
import { keyChainQueryOptions } from '@/hooks/crypto/keys';
import { useAuthStore } from '@/lib/auth';
import { processKeyChain } from '@/lib/epoch-key-cache';
import { leaveConversation } from '@/lib/leave-conversation';
import { LeaveConfirmationModal } from '@/components/chat/member/leave-confirmation-modal';
import type { SidebarConversation } from './chat-item';

/**
 * Opens the leave-confirmation modal for a sidebar conversation row.
 * `isActive` is whether the row's conversation is the one currently open, which
 * decides post-leave navigation.
 */
export type RequestLeave = (conversation: SidebarConversation, isActive: boolean) => void;

function missingProvider(): never {
  throw new Error('useRequestLeave must be used within a LeaveConversationProvider');
}

const LeaveConversationContext = React.createContext<RequestLeave>(missingProvider);

export function useRequestLeave(): RequestLeave {
  return React.useContext(LeaveConversationContext);
}

interface LeaveTarget {
  conversation: SidebarConversation;
  isActive: boolean;
}

/**
 * Owns the sidebar leave-confirmation modal so it outlives the row that opens
 * it. Confirming a leave invalidates the conversation-list query, which drops
 * that row and unmounts its `ChatItem`; if the modal lived inside the row it
 * would unmount mid-close, and on touch devices vaul leaves the drawer's
 * portaled node stuck in the DOM. Rendering the modal here — a stable ancestor
 * of every row — lets the auto-close land on a still-mounted component.
 */
export function LeaveConversationProvider({
  children,
}: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const userId = useAuthStore((s) => s.user?.id);
  const accountPrivateKey = useAuthStore((s) => s.privateKey);
  const leaveMutation = useLeaveConversation();
  const [target, setTarget] = React.useState<LeaveTarget | null>(null);

  const requestLeave = React.useCallback<RequestLeave>((conversation, isActive) => {
    setTarget({ conversation, isActive });
  }, []);

  const handleConfirmLeave = React.useCallback(async (): Promise<void> => {
    /* v8 ignore next -- onConfirm only fires while the modal is open, which requires a non-null target; this is a defensive type-narrow */
    if (!target) return;
    // Defensive: Leave only renders for an authenticated user whose account key
    // is unlocked, so a missing value here is a broken invariant — bubble a
    // plain Error so it surfaces in error tracking rather than being dressed up
    // as a user-facing message.
    if (!userId) throw new Error('leave invoked without authenticated user');
    if (!accountPrivateKey) throw new Error('leave invoked without an unlocked account key');
    await leaveConversation({
      conversationId: target.conversation.id,
      callerId: userId,
      plaintextTitle: target.conversation.title,
      privilege: target.conversation.privilege,
      leave: leaveMutation.mutateAsync,
      // Sidebar Leave can fire from /chat or any page where the user never
      // opened this conversation, so its key chain may not be cached yet
      // (`useDecryptedMessages` only runs on the active chat). Populate it on
      // demand so the non-owner rotation path doesn't throw INTERNAL.
      ensureKeysCached: async (id) => {
        const keyChain = await queryClient.ensureQueryData(keyChainQueryOptions(id));
        processKeyChain(id, keyChain, accountPrivateKey);
      },
    });
    // Only redirect when the user was viewing the chat that just disappeared —
    // leaving a non-active chat from the sidebar leaves the URL alone.
    if (target.isActive) void navigate({ to: ROUTES.CHAT });
  }, [target, userId, accountPrivateKey, queryClient, leaveMutation, navigate]);

  return (
    <LeaveConversationContext.Provider value={requestLeave}>
      {children}
      <LeaveConfirmationModal
        open={target !== null}
        // The modal is controlled and has no trigger, so ActionModal only ever
        // requests a close (cancel, dismiss, or auto-close on success) — clear
        // the target unconditionally.
        onOpenChange={() => {
          setTarget(null);
        }}
        isOwner={false}
        onConfirm={handleConfirmLeave}
      />
    </LeaveConversationContext.Provider>
  );
}
