import * as React from 'react';
import { Search } from 'lucide-react';
import { cn, Input, Separator } from '@hushbox/ui';
import { TEST_IDS, type ConversationListItem } from '@hushbox/shared';
import { useUIStore } from '@/stores/ui';
import { NewChatButton } from './new-chat-button';
import { ChatList } from './chat-list';
import { InboxContent } from './inbox-content';
import { LeaveConversationProvider } from './leave-conversation-controller';

type SidebarTab = 'chats' | 'inbox';

// Sidebar-content needs the inbox-only fields (`accepted`, `invitedByUsername`)
// in addition to the base sidebar conversation shape. The base shape is pulled
// from the shared schema so `privilege` stays typed as `MemberPrivilege`; the
// two inbox fields are kept optional here because the upstream conversations
// query historically supplied them only for pending invites.
type Conversation = Pick<
  ConversationListItem,
  'id' | 'title' | 'currentEpoch' | 'updatedAt' | 'privilege' | 'muted' | 'pinned'
> & {
  accepted?: boolean;
  invitedByUsername?: string | null;
};

interface FilteredConversations {
  filteredAccepted: Conversation[];
  filteredUnaccepted: Conversation[];
}

function filterConversationsBySearch(
  accepted: Conversation[],
  unaccepted: Conversation[],
  searchQuery: string
): FilteredConversations {
  if (!searchQuery) return { filteredAccepted: accepted, filteredUnaccepted: unaccepted };
  const query = searchQuery.toLowerCase();
  return {
    filteredAccepted: accepted.filter((c) => c.title.toLowerCase().includes(query)),
    filteredUnaccepted: unaccepted.filter((c) => {
      return (
        c.title.toLowerCase().includes(query) ||
        (c.invitedByUsername?.toLowerCase().includes(query) ?? false)
      );
    }),
  };
}

interface SidebarPanelsProps {
  activeTab: SidebarTab;
  unacceptedCount: number;
  sidebarOpen: boolean;
  filteredAccepted: Conversation[];
  pinnedCount: number;
  filteredUnaccepted: Conversation[];
  activeConversationId?: string | undefined;
  isAuthenticated: boolean;
  onLoadMore?: (() => void) | undefined;
  hasMore?: boolean | undefined;
  isLoadingMore?: boolean | undefined;
}

function SidebarPanels({
  activeTab,
  unacceptedCount,
  sidebarOpen,
  filteredAccepted,
  pinnedCount,
  filteredUnaccepted,
  activeConversationId,
  isAuthenticated,
  onLoadMore,
  hasMore,
  isLoadingMore,
}: Readonly<SidebarPanelsProps>): React.JSX.Element {
  const hasPinnedAndUnpinned = pinnedCount > 0 && pinnedCount < filteredAccepted.length;

  return (
    <div className="scrollbar-hide min-h-0 flex-1 overflow-hidden">
      <div
        className={`flex h-full transition-transform duration-300 ease-in-out ${
          activeTab === 'inbox' && unacceptedCount > 0 ? '-translate-x-full' : 'translate-x-0'
        }`}
      >
        <div
          data-testid={TEST_IDS.chatListScrollContainer}
          className={cn(
            'h-full w-full flex-shrink-0 overflow-y-auto',
            !sidebarOpen && 'scrollbar-hide'
          )}
        >
          {hasPinnedAndUnpinned ? (
            <>
              <ChatList
                conversations={filteredAccepted.slice(0, pinnedCount)}
                activeId={activeConversationId}
                isAuthenticated={isAuthenticated}
                label="Pinned conversations"
              />
              <div className="px-2 py-1">
                <Separator className="bg-sidebar-border" data-testid={TEST_IDS.pinnedSeparator} />
              </div>
              <ChatList
                conversations={filteredAccepted.slice(pinnedCount)}
                activeId={activeConversationId}
                isAuthenticated={isAuthenticated}
                onLoadMore={onLoadMore}
                hasMore={hasMore}
                isLoadingMore={isLoadingMore}
              />
            </>
          ) : (
            <ChatList
              conversations={filteredAccepted}
              activeId={activeConversationId}
              isAuthenticated={isAuthenticated}
              onLoadMore={onLoadMore}
              hasMore={hasMore}
              isLoadingMore={isLoadingMore}
            />
          )}
        </div>
        {unacceptedCount > 0 && (
          <div className="h-full w-full flex-shrink-0 overflow-y-auto px-1">
            <InboxContent conversations={filteredUnaccepted} />
          </div>
        )}
      </div>
    </div>
  );
}

interface SidebarContentProps {
  conversations: Conversation[];
  activeConversationId?: string | undefined;
  /** Whether the user is authenticated */
  isAuthenticated?: boolean;
  onLoadMore?: (() => void) | undefined;
  hasMore?: boolean | undefined;
  isLoadingMore?: boolean | undefined;
}

interface SidebarTabHeaderProps {
  activeTab: SidebarTab;
  setActiveTab: (tab: SidebarTab) => void;
  unacceptedCount: number;
}

function SidebarTabHeader({
  activeTab,
  setActiveTab,
  unacceptedCount,
}: Readonly<SidebarTabHeaderProps>): React.JSX.Element {
  if (unacceptedCount === 0) {
    return (
      <h2 className="text-sidebar-foreground/60 px-2 text-xs font-medium tracking-wide uppercase">
        Recent Chats
      </h2>
    );
  }

  return (
    <div className="flex items-center justify-between px-2">
      <button
        className={`text-xs font-medium tracking-wide uppercase transition-colors ${
          activeTab === 'chats'
            ? 'text-sidebar-foreground'
            : 'text-sidebar-foreground/40 hover:text-sidebar-foreground/60'
        }`}
        onClick={() => {
          setActiveTab('chats');
        }}
      >
        Recent Chats
      </button>
      <button
        className={`flex items-center gap-1.5 text-xs font-medium tracking-wide uppercase transition-colors ${
          activeTab === 'inbox'
            ? 'text-sidebar-foreground'
            : 'text-sidebar-foreground/40 hover:text-sidebar-foreground/60'
        }`}
        onClick={() => {
          setActiveTab('inbox');
        }}
      >
        Invites
        <span className="bg-primary text-primary-foreground inline-flex h-4 min-w-4 -translate-y-px items-center justify-center rounded-full px-1 text-[10px] font-bold">
          {unacceptedCount}
        </span>
      </button>
    </div>
  );
}

export function SidebarContent({
  conversations,
  activeConversationId,
  isAuthenticated = true,
  onLoadMore,
  hasMore,
  isLoadingMore,
}: Readonly<SidebarContentProps>): React.JSX.Element {
  const sidebarOpen = useUIStore((state) => state.sidebarOpen);
  const [searchQuery, setSearchQuery] = React.useState('');
  const [activeTab, setActiveTab] = React.useState<SidebarTab>('chats');

  const accepted = conversations.filter((c) => c.accepted !== false);
  const unaccepted = conversations.filter((c) => c.accepted === false);

  // Auto-switch to chats when last invite is handled
  const previousUnacceptedCount = React.useRef(unaccepted.length);
  React.useEffect(() => {
    if (previousUnacceptedCount.current > 0 && unaccepted.length === 0 && activeTab === 'inbox') {
      setActiveTab('chats');
    }
    previousUnacceptedCount.current = unaccepted.length;
  }, [unaccepted.length, activeTab]);

  const { filteredAccepted, filteredUnaccepted } = filterConversationsBySearch(
    accepted,
    unaccepted,
    searchQuery
  );

  // Stable-partition: pinned first, then unpinned (both keep existing order)
  const pinned = filteredAccepted.filter((c) => c.pinned);
  const unpinned = filteredAccepted.filter((c) => !c.pinned);
  const sortedAccepted = [...pinned, ...unpinned];

  return (
    <LeaveConversationProvider>
      <nav
        data-testid={TEST_IDS.sidebarNav}
        aria-label="Chat navigation"
        className="flex min-h-0 flex-1 flex-col gap-2"
      >
        <div className={sidebarOpen ? 'flex flex-col gap-3' : 'flex flex-col items-center gap-3'}>
          <NewChatButton />
          {sidebarOpen && (
            <Input
              icon={<Search className="h-5 w-5" aria-hidden="true" />}
              label="Search chats"
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
              }}
            />
          )}
        </div>

        <Separator className="bg-sidebar-border" />

        {sidebarOpen && (
          <SidebarTabHeader
            activeTab={activeTab}
            setActiveTab={setActiveTab}
            unacceptedCount={unaccepted.length}
          />
        )}

        <SidebarPanels
          activeTab={activeTab}
          unacceptedCount={unaccepted.length}
          sidebarOpen={sidebarOpen}
          filteredAccepted={sortedAccepted}
          pinnedCount={pinned.length}
          filteredUnaccepted={filteredUnaccepted}
          activeConversationId={activeConversationId}
          isAuthenticated={isAuthenticated}
          onLoadMore={onLoadMore}
          hasMore={hasMore}
          isLoadingMore={isLoadingMore}
        />
      </nav>
    </LeaveConversationProvider>
  );
}
