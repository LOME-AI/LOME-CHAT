import * as React from 'react';
import { Navigate, useNavigate } from '@tanstack/react-router';
import { ROUTES, TEST_IDS } from '@hushbox/shared';
import { ChatLayout } from '@/components/chat/layout/chat-layout';
import { useAuthenticatedChat } from '@/hooks/chat/use-authenticated-chat';
import { useGroupChat } from '@/hooks/realtime/use-group-chat';
import { useForks } from '@/hooks/chat/forks';
import { useCreateFork, useDeleteFork, useRenameFork } from '@/hooks/chat/forks';
import { useForkStore } from '@/stores/fork';
import { useChatEditStore } from '@/stores/chat-edit';
import { RenameConversationDialog } from '@/components/sidebar/rename-conversation-dialog';
import { DeleteConversationDialog } from '@/components/sidebar/delete-conversation-dialog';
import { resolveRegenerateTarget } from '@/lib/chat-regeneration';
import type { FundingSource, MemberPrivilege } from '@hushbox/shared';
import type { Message } from '@/lib/api';

interface AuthenticatedChatPageProps {
  readonly routeConversationId: string;
  readonly initialForkId?: string | undefined;
  readonly privateKeyOverride?: Uint8Array | null | undefined;
}

// eslint-disable-next-line @typescript-eslint/no-empty-function -- Required for disabled submit handler
const NOOP = (): void => {};

// Hoisted so the element — and the props object TanStack's <Navigate> reads — is
// referentially stable across renders. <Navigate> guards re-navigation by
// comparing its props by reference; an inline <Navigate> allocates fresh props
// every render, re-firing navigate on every commit during the async redirect
// window → "Maximum update depth exceeded" on a 404/access-revoked conversation.
const REDIRECT_TO_CHAT = <Navigate to={ROUTES.CHAT} />;

function buildPhantomMessages(
  remotePhantoms:
    | Map<string, import('@/hooks/realtime/use-remote-streaming').PhantomMessage>
    | undefined,
  existingMessages: Message[],
  conversationId: string | null
): Message[] {
  if (!remotePhantoms || remotePhantoms.size === 0) return [];
  const existingIds = new Set(existingMessages.map((m) => m.id));
  const result: Message[] = [];
  for (const [id, phantom] of remotePhantoms) {
    if (existingIds.has(id)) continue;
    result.push({
      id,
      /* v8 ignore next -- phantoms only exist for an active group conversation, so conversationId is non-null here; the ?? '' only satisfies the nullable type */
      conversationId: conversationId ?? '',
      role: phantom.senderType === 'user' ? 'user' : 'assistant',
      content: phantom.content,
      createdAt: '',
      ...(phantom.senderId !== undefined && { senderId: phantom.senderId }),
      ...(phantom.modelName !== undefined && { modelName: phantom.modelName }),
    });
  }
  return result;
}

function findRemoteStreamingIds(
  remotePhantoms:
    | Map<string, import('@/hooks/realtime/use-remote-streaming').PhantomMessage>
    | undefined
): Set<string> {
  const ids = new Set<string>();
  if (!remotePhantoms) return ids;
  for (const [id, phantom] of remotePhantoms) {
    if (phantom.senderType === 'ai') ids.add(id);
  }
  return ids;
}

function resolveConversationId(
  routeConversationId: string,
  realConversationId: string | null
): string | null {
  return routeConversationId === 'new' ? realConversationId : routeConversationId;
}

function combineWithPhantoms(baseMessages: Message[], phantoms: Message[]): Message[] {
  if (phantoms.length === 0) return baseMessages;
  return [...baseMessages, ...phantoms];
}

interface ForkItem {
  id: string;
  conversationId: string;
  name: string;
  tipMessageId: string | null;
  createdAt: string;
}

interface ForkUrlStateArgs {
  routeConversationId: string;
  initialForkId: string | undefined;
  activeForkId: string | null;
  forksList: ForkItem[];
  setActiveFork: (id: string | null) => void;
}

// Owns the active fork ↔ URL relationship. The `?fork=` search param is the
// source of truth on load (so deep links and page reloads restore the right
// fork); the store carries it for the rest of the session.
function useForkUrlState({
  routeConversationId,
  initialForkId,
  activeForkId,
  forksList,
  setActiveFork,
}: ForkUrlStateArgs): void {
  const navigate = useNavigate();
  const seedResolvedRef = React.useRef(false);
  // Whether a fork has been active at any point this session. Distinguishes the
  // pre-seed load window (never activated → a deep-linked `?fork=` must survive)
  // from a fork that was selected and then deleted (activated → its now-stale
  // param must be cleared).
  const hasActivatedForkRef = React.useRef(false);

  // Route the fork search param through the router (the single writer); a raw
  // history.replaceState races TanStack Router's own search parsing. Called with
  // no argument clears the param.
  const replaceForkSearch = React.useCallback(
    (fork?: string): void => {
      void navigate({
        to: ROUTES.CHAT_ID,
        params: { id: routeConversationId },
        search: { fork },
        replace: true,
      });
    },
    [navigate, routeConversationId]
  );

  React.useEffect(() => {
    // Seed the active fork from the URL `?fork=` param, and keep the Main fallback
    // from running until that seed has taken hold in the store. Latching on the
    // first render raced the store update: a re-render arriving before
    // setActiveFork was reflected fell through to the fallback and clobbered the
    // deep-linked fork with Main.
    if (!seedResolvedRef.current) {
      if (initialForkId && activeForkId === null) {
        setActiveFork(initialForkId);
        return;
      }
      // The store now holds a value (the seed took, or a real selection already
      // existed), or there was nothing to seed — either way the fallback is
      // unblocked from here on.
      seedResolvedRef.current = true;
    }
    // Fallback: forks exist but nothing is selected (no `?fork=` on load, or the
    // active fork was just deleted) → default to Main (earliest createdAt).
    if (activeForkId === null && forksList.length >= 2) {
      const sorted = forksList.toSorted(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      );
      if (sorted[0]) {
        setActiveFork(sorted[0].id);
      }
    }
  }, [initialForkId, activeForkId, forksList, setActiveFork]);

  React.useEffect(() => {
    // Mirror the active fork into the URL. The route stays the single writer.
    if (!seedResolvedRef.current) {
      return;
    }
    if (activeForkId !== null) {
      hasActivatedForkRef.current = true;
      // Already reflected by the URL the page loaded with — nothing to write.
      if (activeForkId === initialForkId) {
        return;
      }
      replaceForkSearch(activeForkId);
      return;
    }
    // No active fork. Never clear during the pre-seed load window — that would
    // strip a deep-linked `?fork=` before the seed reads it. Only clear once a
    // fork has actually been active and then went away (last fork deleted →
    // conversation reverted to linear), leaving a stale param behind.
    if (!hasActivatedForkRef.current) {
      return;
    }
    replaceForkSearch();
  }, [initialForkId, activeForkId, replaceForkSearch]);
}

interface ForkManagement {
  renamingFork: { id: string; name: string } | null;
  setRenamingFork: React.Dispatch<React.SetStateAction<{ id: string; name: string } | null>>;
  renameValue: string;
  setRenameValue: React.Dispatch<React.SetStateAction<string>>;
  deletingFork: { id: string; name: string } | null;
  setDeletingFork: React.Dispatch<React.SetStateAction<{ id: string; name: string } | null>>;
  handleForkSelect: (forkId: string) => void;
  handleForkRename: (forkId: string, currentName: string) => void;
  handleConfirmRename: () => void;
  handleForkDelete: (forkId: string) => void;
  handleConfirmDelete: () => void;
  handleForkFromMessage: (messageId: string) => void;
}

function useForkManagement(
  conversationId: string | null,
  forksList: ForkItem[],
  activeForkId: string | null,
  setActiveFork: (id: string | null) => void
): ForkManagement {
  const createFork = useCreateFork();
  const deleteFork = useDeleteFork();
  const renameFork = useRenameFork();

  const [renamingFork, setRenamingFork] = React.useState<{ id: string; name: string } | null>(null);
  const [renameValue, setRenameValue] = React.useState('');
  const [deletingFork, setDeletingFork] = React.useState<{ id: string; name: string } | null>(null);

  const handleForkSelect = React.useCallback(
    (forkId: string): void => {
      setActiveFork(forkId);
    },
    [setActiveFork]
  );

  const handleForkRename = React.useCallback((forkId: string, currentName: string): void => {
    setRenamingFork({ id: forkId, name: currentName });
    setRenameValue(currentName);
  }, []);

  const handleConfirmRename = React.useCallback((): void => {
    if (!renamingFork || !renameValue.trim() || !conversationId) return;
    renameFork.mutate({ conversationId, forkId: renamingFork.id, name: renameValue.trim() });
    setRenamingFork(null);
  }, [renamingFork, renameValue, conversationId, renameFork]);

  const handleForkDelete = React.useCallback(
    (forkId: string): void => {
      const fork = forksList.find((f) => f.id === forkId);
      setDeletingFork({ id: forkId, name: fork?.name ?? 'Fork' });
    },
    [forksList]
  );

  const handleConfirmDelete = React.useCallback((): void => {
    /* v8 ignore next -- the delete dialog only opens for an existing fork on an active conversation, so this guard's early-return is unreachable via the UI */
    if (!deletingFork || !conversationId) return;
    const forkId = deletingFork.id;
    deleteFork.mutate(
      { conversationId, forkId },
      {
        onSuccess: () => {
          if (activeForkId === forkId) {
            // Set to null — the auto-select effect will pick the correct fork
            // from the updated forksList after the query refetch.
            setActiveFork(null);
          }
        },
      }
    );
    setDeletingFork(null);
  }, [deletingFork, conversationId, deleteFork, activeForkId, setActiveFork]);

  const handleForkFromMessage = React.useCallback(
    (messageId: string): void => {
      /* v8 ignore next -- fork-from-message is only reachable from a rendered conversation, so conversationId is always present here */
      if (!conversationId) return;
      const forkId = crypto.randomUUID();
      const previousForkId = activeForkId;
      // Claim the new fork as active immediately. Setting it only in onSuccess
      // left a window where the forks query refetched to >= 2 forks but
      // activeForkId was still null, which the Main fallback filled — clobbering
      // the just-created fork. Revert if creation fails.
      setActiveFork(forkId);
      createFork.mutate(
        { id: forkId, conversationId, fromMessageId: messageId },
        {
          onError: () => {
            setActiveFork(previousForkId);
          },
        }
      );
    },
    [conversationId, createFork, setActiveFork, activeForkId]
  );

  return {
    renamingFork,
    setRenamingFork,
    renameValue,
    setRenameValue,
    deletingFork,
    setDeletingFork,
    handleForkSelect,
    handleForkRename,
    handleConfirmRename,
    handleForkDelete,
    handleConfirmDelete,
    handleForkFromMessage,
  };
}

function ForkDialogs({ fm }: Readonly<{ fm: ForkManagement }>): React.JSX.Element | null {
  return (
    <>
      <RenameConversationDialog
        open={fm.renamingFork !== null}
        onOpenChange={(open) => {
          /* v8 ignore next -- a controlled dialog only emits onOpenChange(false); the open===true branch is unreachable */
          if (!open) fm.setRenamingFork(null);
        }}
        value={fm.renameValue}
        onValueChange={fm.setRenameValue}
        onConfirm={fm.handleConfirmRename}
      />
      <DeleteConversationDialog
        open={fm.deletingFork !== null}
        onOpenChange={(open) => {
          /* v8 ignore next -- a controlled dialog only emits onOpenChange(false); the open===true branch is unreachable */
          if (!open) fm.setDeletingFork(null);
        }}
        title={fm.deletingFork?.name ?? ''}
        onConfirm={fm.handleConfirmDelete}
      />
    </>
  );
}

// Holds the latest `value` in a ref without writing or reading it during render.
// useInsertionEffect commits the update before passive/layout effects and event
// handlers run, so reads from those contexts always see the current value.
function useLatestRef<T>(value: T): React.RefObject<T> {
  const ref = React.useRef(value);
  React.useInsertionEffect(() => {
    ref.current = value;
  });
  return ref;
}

/** Default callerPrivilege to 'read' during loading for link guests to prevent notification flash. */
function resolveGuestPrivilege(
  isLinkGuest: boolean,
  callerPrivilege: MemberPrivilege | undefined
): MemberPrivilege | undefined {
  if (!isLinkGuest) return callerPrivilege;
  return callerPrivilege ?? 'read';
}

export function AuthenticatedChatPage({
  routeConversationId,
  initialForkId,
  privateKeyOverride,
}: AuthenticatedChatPageProps): React.JSX.Element {
  const { editingMessageId, startEditing, clearEditing } = useChatEditStore();

  const { activeForkId, setActiveFork } = useForkStore();

  const chat = useAuthenticatedChat({ routeConversationId, activeForkId, privateKeyOverride });
  const conversationId = resolveConversationId(routeConversationId, chat.realConversationId);
  const groupChat = useGroupChat(conversationId, chat.callerId, chat.displayTitle);

  const forksQueryId = conversationId ?? '';
  const { data: forks } = useForks(forksQueryId);
  const forksList = React.useMemo(() => forks ?? [], [forks]);

  useForkUrlState({ routeConversationId, initialForkId, activeForkId, forksList, setActiveFork });

  const fm = useForkManagement(conversationId, forksList, activeForkId, setActiveFork);

  // useAuthenticatedChat rebuilds handleSend / handleRegenerate every render
  // (their useCallback deps include the per-render `state` object), so reading
  // the latest values through refs — only inside the event handlers below, never
  // during render — keeps these wrappers referentially stable. That stability is
  // what lets the memoized ChatMainContent → MessageList skip re-rendering on a
  // prompt-input keystroke. setInputValue and the edit-store actions are already
  // stable, so handlers that only use those depend on them directly.
  const chatRef = useLatestRef(chat);
  const setInputValue = chat.state.setInputValue;

  const handleRegenerate = React.useCallback(
    (messageId: string): void => {
      const current = chatRef.current;
      const { targetMessageId, action, replaceAssistantId } = resolveRegenerateTarget(
        current.messages,
        messageId
      );
      current.handleRegenerate(targetMessageId, action, undefined, replaceAssistantId);
    },
    [chatRef]
  );

  const handleEdit = React.useCallback(
    (messageId: string, content: string): void => {
      startEditing(messageId, content);
      setInputValue(content);
    },
    [startEditing, setInputValue]
  );

  const handleCancelEdit = React.useCallback((): void => {
    clearEditing();
    setInputValue('');
  }, [clearEditing, setInputValue]);

  const handleEditSubmit = React.useCallback(
    (fundingSource: FundingSource): void => {
      const current = chatRef.current;
      if (!editingMessageId) {
        current.handleSend(fundingSource);
        return;
      }
      current.handleRegenerate(editingMessageId, 'edit', current.state.inputValue);
      clearEditing();
    },
    [editingMessageId, clearEditing, chatRef]
  );

  const isLinkGuest = privateKeyOverride != null;
  const remotePhantoms = groupChat?.remoteStreamingMessages;
  const phantomMessages = React.useMemo(
    () => buildPhantomMessages(remotePhantoms, chat.messages, conversationId),
    [remotePhantoms, conversationId, chat.messages]
  );

  const messagesWithPhantoms = React.useMemo(
    () => combineWithPhantoms(chat.messages, phantomMessages),
    [chat.messages, phantomMessages]
  );

  // Fork filtering is already applied inside useAuthenticatedChat (via forkFilteredDecrypted
  // passed to mergeMessages). Optimistic messages are appended after fork filtering, so they
  // remain visible during streaming. No need to re-apply fork filter here.

  const remoteStreamingIds = React.useMemo(
    () => findRemoteStreamingIds(remotePhantoms),
    [remotePhantoms]
  );

  const effectiveStreamingIds =
    chat.state.streamingMessageIds.size > 0 ? chat.state.streamingMessageIds : remoteStreamingIds;

  // Persistence-tracking has no remote-streaming equivalent (group-chat
  // phantoms originate on another client, where their persistence is the
  // remote sender's concern). Local data-streaming-count therefore reflects
  // only this tab's in-flight commits — that's what local tests care about.
  const effectivePersistingIds = chat.state.persistingMessageIds;

  if (chat.renderState.type === 'redirecting' || chat.renderState.type === 'not-found') {
    if (isLinkGuest) {
      return (
        <div
          className="flex h-full items-center justify-center"
          data-testid={TEST_IDS.sharedConversationError}
        >
          <p className="text-muted-foreground">This shared link is no longer available.</p>
        </div>
      );
    }
    return REDIRECT_TO_CHAT;
  }

  if (chat.renderState.type === 'loading') {
    return (
      <ChatLayout
        title={chat.renderState.title}
        messages={[]}
        streamingMessageIds={new Set<string>()}
        persistingMessageIds={new Set<string>()}
        inputValue=""
        onInputChange={chat.state.setInputValue}
        onSubmit={NOOP}
        inputDisabled={true}
        isProcessing={false}
        historyCharacters={0}
        isAuthenticated={!isLinkGuest}
        isLinkGuest={isLinkGuest}
        isDecrypting={true}
        conversationId={conversationId ?? undefined}
        groupChat={groupChat}
        callerPrivilege={resolveGuestPrivilege(isLinkGuest, chat.callerPrivilege)}
      />
    );
  }

  return (
    <>
      <ChatLayout
        title={chat.displayTitle}
        messages={messagesWithPhantoms}
        streamingMessageIds={effectiveStreamingIds}
        persistingMessageIds={effectivePersistingIds}
        inputValue={chat.state.inputValue}
        onInputChange={chat.state.setInputValue}
        onSubmit={handleEditSubmit}
        onSubmitUserOnly={chat.handleSendUserOnly}
        inputDisabled={chat.inputDisabled}
        isProcessing={chat.isStreaming}
        onStop={chat.handleStop}
        onQueue={chat.onQueueMessage}
        queueCount={chat.queueCount}
        queueFull={chat.queueFull}
        queuedMessages={chat.queuedMessages}
        onCancelQueued={chat.onCancelQueued}
        historyCharacters={chat.historyCharacters}
        isAuthenticated={!isLinkGuest}
        isLinkGuest={isLinkGuest}
        promptInputRef={chat.promptInputRef}
        errorMessageId={chat.errorMessageId}
        conversationId={conversationId ?? undefined}
        groupChat={groupChat}
        callerPrivilege={chat.callerPrivilege}
        forks={forksList}
        activeForkId={activeForkId}
        onForkSelect={fm.handleForkSelect}
        onForkRename={fm.handleForkRename}
        onForkDelete={fm.handleForkDelete}
        onRegenerate={handleRegenerate}
        onEdit={handleEdit}
        onFork={fm.handleForkFromMessage}
        isEditing={editingMessageId !== null}
        onCancelEdit={handleCancelEdit}
        messagesReady={chat.messagesReady}
      />
      <ForkDialogs fm={fm} />
    </>
  );
}
