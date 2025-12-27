import * as React from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@lome-chat/ui';
import { useUIStore } from '@/stores/ui';
import { useConversations } from '@/hooks/chat';
import { SidebarContent } from './sidebar-content';
import { SidebarFooter } from './sidebar-footer';

/**
 * Mobile sidebar that slides in from the left as an overlay.
 * Uses Sheet component for the slide-over behavior.
 */
export function MobileSidebar(): React.JSX.Element {
  const { mobileSidebarOpen, setMobileSidebarOpen } = useUIStore();
  const { data: conversations, isLoading } = useConversations();

  // Force sidebar to appear expanded in mobile mode
  React.useEffect(() => {
    if (mobileSidebarOpen) {
      useUIStore.setState({ sidebarOpen: true });
    }
  }, [mobileSidebarOpen]);

  return (
    <Sheet open={mobileSidebarOpen} onOpenChange={setMobileSidebarOpen}>
      <SheetContent
        side="left"
        className="bg-sidebar text-sidebar-foreground flex w-72 flex-col p-0"
        data-testid="mobile-sidebar"
      >
        <SheetHeader className="border-sidebar-border border-b p-4">
          <SheetTitle className="text-sidebar-foreground text-lg font-semibold">Menu</SheetTitle>
        </SheetHeader>

        {isLoading ? (
          <div className="flex flex-1 items-center justify-center">
            <span className="text-sidebar-foreground/50 text-sm">Loading...</span>
          </div>
        ) : (
          <SidebarContent conversations={conversations ?? []} />
        )}

        <SidebarFooter />
      </SheetContent>
    </Sheet>
  );
}
