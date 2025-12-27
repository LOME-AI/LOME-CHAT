import * as React from 'react';
import { Input, Separator } from '@lome-chat/ui';
import { Search } from 'lucide-react';
import { useUIStore } from '@/stores/ui';
import { NewChatButton } from './new-chat-button';
import { ChatList } from './chat-list';
import { ProjectsLink } from './projects-link';

interface Conversation {
  id: string;
  title: string;
  updatedAt: string;
}

interface SidebarContentProps {
  conversations: Conversation[];
  activeConversationId?: string;
}

export function SidebarContent({
  conversations,
  activeConversationId,
}: SidebarContentProps): React.JSX.Element {
  const sidebarOpen = useUIStore((state) => state.sidebarOpen);
  const [searchQuery, setSearchQuery] = React.useState('');

  // Filter conversations based on search query
  const filteredConversations = searchQuery
    ? conversations.filter((c) => c.title.toLowerCase().includes(searchQuery.toLowerCase()))
    : conversations;

  return (
    <nav
      data-testid="sidebar-nav"
      aria-label="Chat navigation"
      className="flex min-h-0 flex-1 flex-col gap-2 p-2"
    >
      <div className={sidebarOpen ? 'flex flex-col gap-3' : 'flex flex-col items-center gap-3'}>
        <NewChatButton />
        {sidebarOpen && (
          <Input
            icon={<Search className="h-5 w-5" aria-hidden="true" />}
            label="Search"
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
            }}
          />
        )}
      </div>

      <Separator className="bg-sidebar-border" />

      {/* Recent Chats title */}
      {sidebarOpen && (
        <h2 className="text-sidebar-foreground/60 px-2 text-xs font-medium tracking-wide uppercase">
          Recent Chats
        </h2>
      )}

      {/* Scrollable chat list with hidden scrollbar */}
      <div className="scrollbar-hide min-h-0 flex-1 overflow-y-auto">
        <ChatList conversations={filteredConversations} activeId={activeConversationId} />
      </div>

      <Separator className="bg-sidebar-border" />

      <div className={sidebarOpen ? '' : 'flex justify-center'}>
        <ProjectsLink />
      </div>
    </nav>
  );
}
