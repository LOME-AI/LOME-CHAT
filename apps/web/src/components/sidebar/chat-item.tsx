import * as React from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import {
  Bell,
  BellOff,
  Lock,
  LogOut,
  MessageSquare,
  Pencil,
  Pin,
  PinOff,
  Trash2,
} from 'lucide-react';
import { cn, DropdownMenuItem } from '@hushbox/ui';
import { encryptTextForEpoch, getPublicKeyFromPrivate } from '@hushbox/crypto';
import { toBase64, ROUTES, TEST_IDS, type ConversationListItem } from '@hushbox/shared';
import { ItemRow } from '@/components/shared/item-row';
import { useUIStore } from '@/stores/ui';
import { useDeleteConversation, useUpdateConversation, DECRYPTING_TITLE } from '@/hooks/chat/chat';
import {
  useLeaveConversation,
  useMuteConversation,
  usePinConversation,
} from '@/hooks/realtime/use-conversation-members';
import { keyChainQueryOptions } from '@/hooks/crypto/keys';
import { useAuthStore } from '@/lib/auth';
import { getEpochKey, processKeyChain } from '@/lib/epoch-key-cache';
import { leaveConversation } from '@/lib/leave-conversation';
import { LeaveConfirmationModal } from '@/components/chat/member/leave-confirmation-modal';
import { DeleteConversationDialog } from './delete-conversation-dialog';
import { RenameConversationDialog } from './rename-conversation-dialog';

// Subset of the API conversation list-item we render in the sidebar. Pulling
// the shape from the shared schema keeps `privilege` typed as `MemberPrivilege`
// — a stringly-typed local would let an invalid value silently drift past TS.
// Exported so parent components (chat-list, sidebar-content) share the same
// definition rather than declaring their own widened copies.
export type SidebarConversation = Pick<
  ConversationListItem,
  'id' | 'title' | 'currentEpoch' | 'updatedAt' | 'privilege' | 'muted' | 'pinned'
>;

interface ChatItemProps {
  conversation: SidebarConversation;
  isActive?: boolean;
}

function ChatItemTitle({ title }: Readonly<{ title: string }>): React.JSX.Element {
  if (title === DECRYPTING_TITLE) {
    return (
      <span
        className="text-muted-foreground flex items-center gap-1.5 truncate text-xs"
        data-testid={TEST_IDS.decryptingTitle}
      >
        <Lock className="h-3 w-3 shrink-0" />
        Decrypting...
      </span>
    );
  }
  return <span className="truncate">{title}</span>;
}

function encryptTitle(
  conversationId: string,
  currentEpoch: number,
  rawTitle: string
): string | undefined {
  const trimmed = rawTitle.trim();
  /* v8 ignore next -- RenameConversationDialog disables its save button on `!value.trim()`, so encryptTitle is never reached with an empty title; this is a defensive double-check */
  if (!trimmed) return undefined;
  const epochPrivateKey = getEpochKey(conversationId, currentEpoch);
  if (!epochPrivateKey) return undefined;
  const epochPublicKey = getPublicKeyFromPrivate(epochPrivateKey);
  return toBase64(encryptTextForEpoch(epochPublicKey, trimmed));
}

function ChatItemMenuContent({
  conversation,
  onDelete,
  onRename,
  onLeave,
}: Readonly<{
  conversation: SidebarConversation;
  onDelete: () => void;
  onRename: () => void;
  onLeave: () => void;
}>): React.JSX.Element {
  const muteConversation = useMuteConversation();
  const pinConversation = usePinConversation();
  const isOwner = conversation.privilege === 'owner';

  const handlePinToggle = (): void => {
    pinConversation.mutate({
      conversationId: conversation.id,
      pinned: !conversation.pinned,
    });
  };

  const handleMuteToggle = (): void => {
    muteConversation.mutate({
      conversationId: conversation.id,
      muted: !conversation.muted,
    });
  };

  return (
    <>
      <DropdownMenuItem onSelect={handlePinToggle}>
        {conversation.pinned ? <PinOff /> : <Pin />}
        {conversation.pinned ? 'Unpin' : 'Pin'}
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={handleMuteToggle}>
        {conversation.muted ? <Bell /> : <BellOff />}
        {conversation.muted ? 'Unmute' : 'Mute'}
      </DropdownMenuItem>
      {isOwner ? (
        <>
          <DropdownMenuItem onSelect={onRename}>
            <Pencil />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onDelete} className="text-destructive">
            <Trash2 />
            Delete
          </DropdownMenuItem>
        </>
      ) : (
        <DropdownMenuItem onSelect={onLeave} className="text-destructive">
          <LogOut />
          Leave
        </DropdownMenuItem>
      )}
    </>
  );
}

// Memoized so a sidebar-search keystroke (which recreates the filtered array
// but keeps each conversation object reference stable) doesn't re-render every
// row. Shallow prop comparison suffices given the stable references.
export const ChatItem = React.memo(function ChatItem({
  conversation,
  isActive = false,
}: Readonly<ChatItemProps>): React.JSX.Element {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const sidebarOpen = useUIStore((state) => state.sidebarOpen);
  const userId = useAuthStore((s) => s.user?.id);
  const accountPrivateKey = useAuthStore((s) => s.privateKey);
  const deleteConversation = useDeleteConversation();
  const updateConversation = useUpdateConversation();
  const leaveMutation = useLeaveConversation();

  const [showDeleteDialog, setShowDeleteDialog] = React.useState(false);
  const [showRenameDialog, setShowRenameDialog] = React.useState(false);
  const [showLeaveDialog, setShowLeaveDialog] = React.useState(false);
  const [renameValue, setRenameValue] = React.useState(conversation.title);

  const handleDeleteClick = (): void => {
    setShowDeleteDialog(true);
  };

  const handleRenameClick = (): void => {
    setRenameValue(conversation.title);
    setShowRenameDialog(true);
  };

  const handleConfirmDelete = (): void => {
    deleteConversation.mutate(conversation.id, {
      onSuccess: () => {
        setShowDeleteDialog(false);
        void navigate({ to: ROUTES.CHAT });
      },
    });
  };

  const handleLeaveClick = (): void => {
    setShowLeaveDialog(true);
  };

  const handleConfirmLeave = React.useCallback(async (): Promise<void> => {
    // Defensive: the leave option only renders inside the dropdown for an
    // authenticated user, so a missing userId here represents broken invariant
    // — bubble as a plain Error so it shows up in error tracking instead of
    // being dressed up as a user-facing message.
    if (!userId) throw new Error('chat-item leave invoked without authenticated user');
    if (!accountPrivateKey) {
      throw new Error('chat-item leave invoked without an unlocked account key');
    }
    await leaveConversation({
      conversationId: conversation.id,
      callerId: userId,
      plaintextTitle: conversation.title,
      privilege: conversation.privilege,
      leave: leaveMutation.mutateAsync,
      // Sidebar Leave can fire from /chat or any other page where the user
      // has never opened this conversation, so its key chain may not yet be
      // in the cache (`useDecryptedMessages` only runs on the active chat).
      // Populate it on demand so the non-owner rotation path doesn't throw
      // INTERNAL on first try.
      ensureKeysCached: async (id) => {
        const keyChain = await queryClient.ensureQueryData(keyChainQueryOptions(id));
        processKeyChain(id, keyChain, accountPrivateKey);
      },
    });
    // Only redirect when the user was actually viewing the chat that just
    // disappeared — leaving a non-active chat from the sidebar list should
    // leave the URL alone.
    if (isActive) void navigate({ to: ROUTES.CHAT });
  }, [userId, accountPrivateKey, queryClient, conversation, leaveMutation, isActive, navigate]);

  const handleConfirmRename = (): void => {
    const encrypted = encryptTitle(conversation.id, conversation.currentEpoch, renameValue);
    if (!encrypted) return;

    updateConversation.mutate(
      {
        conversationId: conversation.id,
        data: {
          title: encrypted,
          titleEpochNumber: conversation.currentEpoch,
        },
      },
      {
        onSuccess: () => {
          setShowRenameDialog(false);
        },
      }
    );
  };

  return (
    <>
      <ItemRow
        className={cn(
          '[&:hover:not(:has([data-menu-trigger]:hover))]:bg-sidebar-border/50',
          isActive && 'bg-sidebar-border',
          !sidebarOpen && 'justify-center'
        )}
        showMenu={sidebarOpen}
        menuProps={{
          className: 'absolute right-1',
          'data-testid': TEST_IDS.chatItemMoreButton,
          onClick: (e) => {
            e.preventDefault();
          },
        }}
        menuContent={
          <ChatItemMenuContent
            conversation={conversation}
            onDelete={handleDeleteClick}
            onRename={handleRenameClick}
            onLeave={handleLeaveClick}
          />
        }
      >
        <Link
          to={ROUTES.CHAT_ID}
          params={{ id: conversation.id }}
          search={{ fork: undefined }}
          data-testid={TEST_IDS.chatLink}
          className={cn(
            'flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-sm',
            !sidebarOpen && 'justify-center px-0',
            sidebarOpen && 'pr-8'
          )}
        >
          {sidebarOpen ? (
            <ChatItemTitle title={conversation.title} />
          ) : (
            <MessageSquare
              data-testid={TEST_IDS.messageIcon}
              className="h-4 w-4 shrink-0"
              aria-hidden="true"
            />
          )}
        </Link>
      </ItemRow>

      <DeleteConversationDialog
        open={showDeleteDialog}
        onOpenChange={setShowDeleteDialog}
        title={conversation.title}
        onConfirm={handleConfirmDelete}
      />

      <RenameConversationDialog
        open={showRenameDialog}
        onOpenChange={setShowRenameDialog}
        value={renameValue}
        onValueChange={setRenameValue}
        onConfirm={handleConfirmRename}
      />

      <LeaveConfirmationModal
        open={showLeaveDialog}
        onOpenChange={setShowLeaveDialog}
        isOwner={false}
        onConfirm={handleConfirmLeave}
      />
    </>
  );
});
