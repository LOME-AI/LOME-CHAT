import * as React from 'react';
import { cn } from '@lome-chat/ui';
import { useUIStore } from '@/stores/ui';
import { useConversations } from '@/hooks/chat';
import { SidebarHeader } from './sidebar-header';
import { SidebarContent } from './sidebar-content';
import { SidebarFooter } from './sidebar-footer';

export function Sidebar(): React.JSX.Element {
  const sidebarOpen = useUIStore((state) => state.sidebarOpen);
  const { data: conversations, isLoading } = useConversations();

  return (
    <aside
      className={cn(
        'border-sidebar-border bg-sidebar text-sidebar-foreground',
        'hidden h-full flex-col border-r md:flex',
        'overflow-hidden transition-[width] duration-200 ease-in-out',
        sidebarOpen ? 'w-60' : 'w-12'
      )}
    >
      <SidebarHeader />
      {isLoading ? (
        <div className="flex flex-1 items-center justify-center">
          <span className="text-sidebar-foreground/50 text-sm">Loading...</span>
        </div>
      ) : (
        <SidebarContent conversations={conversations ?? []} />
      )}
      <SidebarFooter />
    </aside>
  );
}
