import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useIsMobile, useVisualViewportHeight } from '@hushbox/ui';
import { ChatHeader } from '@/components/chat/layout/chat-header';
import { ComparisonBar } from '@/components/chat/layout/comparison-bar';
import { ForkTabs } from '@/components/chat/layout/fork-tabs';
import { type MessageListHandle } from '@/components/chat/message/message-list';
import { MemberSidebar } from '@/components/chat/member/member-sidebar';
import {
  ChatPromptInput,
  buildChatHeaderGroupProps,
} from '@/components/chat/input/chat-prompt-input';
import { ChatMainContent } from '@/components/chat/layout/chat-main-content';
import { ChatLayoutModals } from '@/components/chat/layout/chat-layout-modals';
import {
  getContentAreaStyle,
  getMobileInputStyle,
  getWebSocketAttributes,
  buildMemberSidebarProps,
  resolveChatLayoutDerivedState,
  resolveForkTabsProps,
} from '@/components/chat/layout/chat-layout-helpers';
import {
  useInputFocusManagement,
  useInputHeightObserver,
  useStreamScrollEffect,
  useSubmitUserOnly,
  useTypingBroadcast,
} from '@/components/chat/layout/chat-layout-hooks';
import { useKeyboardOffset } from '@/hooks/ui/use-keyboard-offset';
import { usePremiumModelClick } from '@/hooks/models/use-premium-model-click';
import { useTierInfo } from '@/hooks/billing/use-tier-info';
import { useModelStore, getPrimaryModel, type SelectedModelEntry } from '@/stores/model';
import { useWebSearch } from '@/hooks/chat/use-web-search';
import { useUIModalsStore } from '@/stores/ui-modals';
import { useSelectedModelCapabilities } from '@/hooks/models/use-selected-model-capabilities';
import { useResolveDefaultModel } from '@/hooks/models/use-resolve-default-model';
import { useDocumentStore } from '@/stores/document';
import type { FundingSource, MemberPrivilege, LegacyModality } from '@hushbox/shared';
import type { ChatSearchProps } from '@/components/chat/input/prompt-input';
import type { GroupChatProps, PromptInputRef } from '@/components/chat/message/types';
import type { Message } from '@/lib/api';

export type { GroupChatProps, PromptInputRef } from '@/components/chat/message/types';

// The document panel pulls the markdown/diagram stack (streamdown → shiki,
// mermaid, katex). Lazy-load it so a text-only chat never drags those into the
// boot graph; it stays empty until a document is opened, so no fallback is
// needed while the chunk resolves.
const DocumentPanel = React.lazy(async () => {
  const m = await import('@/components/document-panel/document-panel');
  return { default: m.DocumentPanel };
});

export interface ChatLayoutProps {
  readonly title?: string | undefined;
  readonly messages: Message[];
  readonly streamingMessageIds: Set<string>;
  /** Server-side persistence-tracking set; see MessageList docs. */
  readonly persistingMessageIds?: Set<string> | undefined;
  readonly inputValue: string;
  readonly onInputChange: (value: string) => void;
  readonly onSubmit: (fundingSource: FundingSource) => void;
  readonly onSubmitUserOnly?: (() => void) | undefined;
  readonly inputDisabled: boolean;
  readonly isProcessing: boolean;
  /** Stops the active run (server settles + bills the partial). */
  readonly onStop?: (() => void) | undefined;
  readonly historyCharacters: number;
  readonly isAuthenticated: boolean;
  readonly promptInputRef?: React.RefObject<PromptInputRef | null> | undefined;
  readonly errorMessageId?: string | undefined;
  readonly isDecrypting?: boolean | undefined;
  readonly conversationId?: string | undefined;
  readonly groupChat?: GroupChatProps | undefined;
  readonly callerPrivilege?: MemberPrivilege | undefined;
  readonly forks?:
    | {
        id: string;
        conversationId: string;
        name: string;
        tipMessageId: string | null;
        createdAt: string;
      }[]
    | undefined;
  readonly activeForkId?: string | null | undefined;
  readonly onForkSelect?: ((forkId: string) => void) | undefined;
  readonly onForkRename?: ((forkId: string, currentName: string) => void) | undefined;
  readonly onForkDelete?: ((forkId: string) => void) | undefined;
  readonly onRegenerate?: ((messageId: string) => void) | undefined;
  readonly onEdit?: ((messageId: string, content: string) => void) | undefined;
  readonly onFork?: ((messageId: string) => void) | undefined;
  readonly isLinkGuest?: boolean | undefined;
  readonly isEditing?: boolean | undefined;
  readonly onCancelEdit?: (() => void) | undefined;
  /** See MessageList docs — parent-derived signal that messages reflect final data. */
  readonly messagesReady?: boolean | undefined;
}

interface LayoutModals {
  signupModalOpen: boolean;
  paymentModalOpen: boolean;
  premiumModelName: string | undefined;
  setSignupModalOpen: (open: boolean) => void;
  setPaymentModalOpen: (open: boolean) => void;
  addMemberModalOpen: boolean;
  budgetSettingsModalOpen: boolean;
  inviteLinkModalOpen: boolean;
  shareMessageModalOpen: boolean;
  shareMessageId: string | null;
  toggleMemberSidebar: () => void;
  mobileMemberSidebarOpen: boolean;
  setMobileMemberSidebarOpen: (open: boolean) => void;
  closeAddMemberModal: () => void;
  openAddMemberModal: () => void;
  closeBudgetSettingsModal: () => void;
  openBudgetSettingsModal: () => void;
  closeInviteLinkModal: () => void;
  openInviteLinkModal: () => void;
  openShareMessageModal: (messageId: string) => void;
  closeShareMessageModal: () => void;
}

function useLayoutModals(): LayoutModals {
  return useUIModalsStore(
    useShallow((s) => ({
      signupModalOpen: s.signupModalOpen,
      paymentModalOpen: s.paymentModalOpen,
      premiumModelName: s.premiumModelName,
      setSignupModalOpen: s.setSignupModalOpen,
      setPaymentModalOpen: s.setPaymentModalOpen,
      addMemberModalOpen: s.addMemberModalOpen,
      budgetSettingsModalOpen: s.budgetSettingsModalOpen,
      inviteLinkModalOpen: s.inviteLinkModalOpen,
      shareMessageModalOpen: s.shareMessageModalOpen,
      shareMessageId: s.shareMessageId,
      toggleMemberSidebar: s.toggleMemberSidebar,
      mobileMemberSidebarOpen: s.mobileMemberSidebarOpen,
      setMobileMemberSidebarOpen: s.setMobileMemberSidebarOpen,
      closeAddMemberModal: s.closeAddMemberModal,
      openAddMemberModal: s.openAddMemberModal,
      closeBudgetSettingsModal: s.closeBudgetSettingsModal,
      openBudgetSettingsModal: s.openBudgetSettingsModal,
      closeInviteLinkModal: s.closeInviteLinkModal,
      openInviteLinkModal: s.openInviteLinkModal,
      openShareMessageModal: s.openShareMessageModal,
      closeShareMessageModal: s.closeShareMessageModal,
    }))
  );
}

export function ChatLayout({
  title,
  messages,
  streamingMessageIds,
  persistingMessageIds,
  inputValue,
  onInputChange,
  onSubmit,
  onSubmitUserOnly,
  inputDisabled,
  isProcessing,
  onStop,
  historyCharacters,
  isAuthenticated,
  promptInputRef: externalPromptInputRef,
  errorMessageId,
  isDecrypting,
  conversationId,
  groupChat,
  callerPrivilege,
  forks,
  activeForkId,
  onForkSelect,
  onForkRename,
  onForkDelete,
  onRegenerate,
  onEdit,
  onFork,
  isLinkGuest,
  isEditing,
  onCancelEdit,
  messagesReady,
}: ChatLayoutProps): React.JSX.Element {
  const viewportHeight = useVisualViewportHeight();
  const isMobile = useIsMobile();
  const { bottom: keyboardOffset, isKeyboardVisible } = useKeyboardOffset();
  const activeModality = useModelStore((state) => state.activeModality);
  const selectedModels = useModelStore((state) => state.selections[state.activeModality]);
  const setActiveModality = useModelStore((state) => state.setActiveModality);
  useResolveDefaultModel(activeModality);
  const webSearch = useWebSearch();
  const selectModality = React.useCallback(
    (modality: LegacyModality): void => {
      setActiveModality(modality);
    },
    [setActiveModality]
  );
  const { models, premiumIds: modelPremiumIds } = useSelectedModelCapabilities();
  // Search is a text-mode feature. Omit searchProps entirely in image mode
  // so the toggle disappears at the structural level, not a render-time check.
  const searchProps: ChatSearchProps | undefined =
    activeModality === 'text'
      ? {
          webSearchEnabled: webSearch.active,
          canUseWebSearch: webSearch.canUse,
          onToggleWebSearch: webSearch.toggle,
        }
      : undefined;
  const handleModelSelect = React.useCallback((entries: SelectedModelEntry[]): void => {
    const { activeModality: current, setSelectedModels } = useModelStore.getState();
    setSelectedModels(current, entries);
  }, []);
  const handleRemoveModel = React.useCallback((modelId: string): void => {
    const { activeModality: current, removeModel } = useModelStore.getState();
    removeModel(current, modelId);
  }, []);
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const handleAddViaComparisonBar = React.useCallback((): void => {
    const { activeModality: current, setPickerMode } = useModelStore.getState();
    setPickerMode(current, 'multi');
    setPickerOpen(true);
  }, []);
  const tierInfo = useTierInfo();
  const tierInfoOrUndefined = tierInfo ?? undefined;
  const handlePremiumClick = usePremiumModelClick(models, isAuthenticated);

  const internalPromptInputRef = React.useRef<PromptInputRef>(null);
  const virtuosoRef = React.useRef<MessageListHandle>(null);
  const inputContainerRef = React.useRef<HTMLDivElement>(null);
  const inputHeight = useInputHeightObserver(isMobile, inputContainerRef);
  const promptInputRef = externalPromptInputRef ?? internalPromptInputRef;

  const modals = useLayoutModals();
  const {
    shareMessageId,
    toggleMemberSidebar,
    mobileMemberSidebarOpen,
    setMobileMemberSidebarOpen,
    openAddMemberModal,
    openBudgetSettingsModal,
    openInviteLinkModal,
    openShareMessageModal,
  } = modals;

  const derived = resolveChatLayoutDerivedState({
    premiumIds: modelPremiumIds,
    tierInfo: tierInfoOrUndefined,
    shareMessageId,
    messages,
  });
  const {
    premiumIds,
    canAccessPremium,
    sharedMessageContent,
    sharedMessageEpochNumber,
    sharedMessageWrappedContentKey,
    sharedMessageMediaItems,
    sharedMessageSenderId,
  } = derived;

  const handleSubmit = React.useCallback(
    (fundingSource: FundingSource): void => {
      onSubmit(fundingSource);
      virtuosoRef.current?.resetScrollBreakaway();
      // eslint-disable-next-line no-restricted-globals -- one-shot rAF defers scroll to next frame, not motion animation
      requestAnimationFrame(() => {
        virtuosoRef.current?.scrollToIndex({ index: 'LAST', align: 'end', behavior: 'smooth' });
      });
    },
    [onSubmit]
  );

  const handleSubmitUserOnly = useSubmitUserOnly(onSubmitUserOnly, virtuosoRef);

  useInputFocusManagement(inputDisabled, isMobile, promptInputRef);
  useStreamScrollEffect(streamingMessageIds, messages.length, virtuosoRef);

  React.useEffect(() => {
    useDocumentStore.getState().closePanel();
  }, [conversationId]);

  const handleFacepileClick = React.useCallback((): void => {
    if (isMobile) {
      setMobileMemberSidebarOpen(!mobileMemberSidebarOpen);
    } else {
      toggleMemberSidebar();
    }
  }, [isMobile, mobileMemberSidebarOpen, setMobileMemberSidebarOpen, toggleMemberSidebar]);

  const handleShareMessage = React.useCallback(
    (messageId: string): void => {
      openShareMessageModal(messageId);
    },
    [openShareMessageModal]
  );

  const handleTypingChange = useTypingBroadcast(groupChat);

  const inputStyle = getMobileInputStyle({ isMobile, keyboardOffset, isKeyboardVisible });
  const { wsConnected, wsReady } = getWebSocketAttributes(groupChat?.ws);

  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
      style={{ height: `${String(viewportHeight)}px` }}
      data-ws-connected={wsConnected}
      data-ws-ready={wsReady}
    >
      <div data-chat-header>
        <ChatHeader
          models={models}
          selectedModels={selectedModels}
          onModelSelect={handleModelSelect}
          title={title}
          premiumIds={premiumIds}
          canAccessPremium={canAccessPremium}
          isAuthenticated={isAuthenticated}
          isLinkGuest={isLinkGuest ?? false}
          onPremiumClick={handlePremiumClick}
          activeModality={activeModality}
          pickerOpen={pickerOpen}
          onPickerOpenChange={setPickerOpen}
          {...buildChatHeaderGroupProps(groupChat, handleFacepileClick)}
        />
      </div>
      <ComparisonBar
        models={models}
        selectedModels={selectedModels}
        onRemoveModel={handleRemoveModel}
        onAddClick={handleAddViaComparisonBar}
      />
      <ForkTabs
        {...resolveForkTabsProps({ forks, activeForkId, onForkSelect, onForkRename, onForkDelete })}
      />
      <div
        className="flex flex-1 overflow-hidden"
        style={getContentAreaStyle(isMobile, inputHeight)}
      >
        <ChatMainContent
          messages={messages}
          streamingMessageIds={streamingMessageIds}
          persistingMessageIds={persistingMessageIds}
          errorMessageId={errorMessageId}
          modelName={getPrimaryModel(selectedModels).id}
          onShare={handleShareMessage}
          onRegenerate={onRegenerate}
          onEdit={onEdit}
          onFork={onFork}
          isDecrypting={isDecrypting}
          groupChat={groupChat}
          virtuosoRef={virtuosoRef}
          isAuthenticated={isAuthenticated}
          isLinkGuest={isLinkGuest ?? false}
          callerPrivilege={callerPrivilege}
          conversationId={conversationId}
          activeForkId={activeForkId}
          messagesReady={messagesReady}
        />
        <React.Suspense fallback={null}>
          <DocumentPanel />
        </React.Suspense>
        {conversationId !== undefined && (
          <MemberSidebar
            conversationId={conversationId}
            {...buildMemberSidebarProps(groupChat)}
            {...(isLinkGuest && { onLeaveClick: undefined })}
            onBudgetSettingsClick={openBudgetSettingsModal}
            onAddMember={openAddMemberModal}
            onInviteLink={openInviteLinkModal}
          />
        )}
      </div>
      <div
        ref={inputContainerRef}
        data-chat-input
        data-chrome=""
        className="bg-background flex-shrink-0 border-t p-4"
        style={inputStyle}
      >
        <div className="mx-auto w-full max-w-3xl">
          <ChatPromptInput
            promptInputRef={promptInputRef}
            inputValue={inputValue}
            onInputChange={onInputChange}
            handleSubmit={handleSubmit}
            historyCharacters={historyCharacters}
            inputDisabled={inputDisabled}
            isProcessing={isProcessing}
            onStop={onStop}
            isMobile={isMobile}
            conversationId={conversationId}
            groupChat={groupChat}
            callerPrivilege={callerPrivilege}
            handleSubmitUserOnly={handleSubmitUserOnly}
            handleTypingChange={handleTypingChange}
            searchProps={searchProps}
            isAuthenticated={isAuthenticated}
            isEditing={isEditing}
            onCancelEdit={onCancelEdit}
            activeModality={activeModality}
            onSelectModality={selectModality}
          />
        </div>
      </div>
      <ChatLayoutModals
        signupModalOpen={modals.signupModalOpen}
        setSignupModalOpen={modals.setSignupModalOpen}
        paymentModalOpen={modals.paymentModalOpen}
        setPaymentModalOpen={modals.setPaymentModalOpen}
        premiumModelName={modals.premiumModelName}
        shareMessageModalOpen={modals.shareMessageModalOpen}
        closeShareMessageModal={modals.closeShareMessageModal}
        shareMessageId={modals.shareMessageId}
        shareMessageConversationId={conversationId ?? null}
        sharedMessageContent={sharedMessageContent}
        sharedMessageEpochNumber={sharedMessageEpochNumber}
        sharedMessageWrappedContentKey={sharedMessageWrappedContentKey}
        sharedMessageMediaItems={sharedMessageMediaItems}
        sharedMessageSenderId={sharedMessageSenderId}
        groupChat={groupChat}
        title={title}
        addMemberModalOpen={modals.addMemberModalOpen}
        closeAddMemberModal={modals.closeAddMemberModal}
        budgetSettingsModalOpen={modals.budgetSettingsModalOpen}
        closeBudgetSettingsModal={modals.closeBudgetSettingsModal}
        inviteLinkModalOpen={modals.inviteLinkModalOpen}
        closeInviteLinkModal={modals.closeInviteLinkModal}
      />
    </div>
  );
}
