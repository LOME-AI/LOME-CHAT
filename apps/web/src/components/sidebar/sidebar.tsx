import * as React from 'react';
import { Link, useLocation, useParams } from '@tanstack/react-router';
import { Lock } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { Logo, SidebarPanel, useIsMobile } from '@hushbox/ui';
import { ROUTES, TEST_IDS } from '@hushbox/shared';
import { useUIStore } from '@/stores/ui';
import { useDecryptedConversations, chatKeys } from '@/hooks/chat/chat';
import { useSession } from '@/lib/auth';
import { NotificationEnablePrompt } from '@/components/notifications/enable-prompt';
import { NotificationEnablePromptRail } from '@/components/notifications/enable-prompt-rail';
import { SidebarContent } from './sidebar-content';
import { SidebarFooter } from './sidebar-footer';

function SidebarLoadingIndicator({
  collapsed,
}: Readonly<{ collapsed: boolean }>): React.JSX.Element {
  return (
    <div
      className="flex flex-1 items-center justify-center"
      data-testid={TEST_IDS.decryptingIndicator}
    >
      {collapsed ? (
        <Lock
          className="text-muted-foreground h-5 w-5 animate-pulse"
          data-testid={TEST_IDS.decryptingLockIcon}
        />
      ) : (
        <span className="text-muted-foreground flex items-center gap-1.5 text-sm">
          <Lock className="h-4 w-4 shrink-0" data-testid={TEST_IDS.decryptingLockIcon} />
          Decrypting...
        </span>
      )}
    </div>
  );
}

export function Sidebar(): React.JSX.Element {
  const isMobile = useIsMobile();
  const { sidebarOpen, toggleSidebar, mobileSidebarOpen, setMobileSidebarOpen } = useUIStore();
  const {
    data: conversations,
    isLoading,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useDecryptedConversations();
  const { data: session, isPending: isSessionPending } = useSession();
  const isAuthenticated = !isSessionPending && Boolean(session?.user);
  const collapsed = !isMobile && !sidebarOpen;

  const queryClient = useQueryClient();
  React.useEffect(() => {
    if (!isAuthenticated && !isSessionPending) {
      queryClient.removeQueries({ queryKey: chatKeys.conversations() });
    }
  }, [isAuthenticated, isSessionPending, queryClient]);

  // The sidebar renders on every route, so read the `$id` param non-strictly:
  // it resolves to the open conversation on `/chat/$id` and to undefined elsewhere.
  const { id: activeConversationId } = useParams({ strict: false });

  const { pathname } = useLocation();
  const previousPathnameRef = React.useRef(pathname);
  React.useEffect(() => {
    if (previousPathnameRef.current !== pathname) {
      previousPathnameRef.current = pathname;
      setMobileSidebarOpen(false);
    }
  }, [pathname, setMobileSidebarOpen]);

  // Clear stale pointer-events left by react-remove-scroll after Sheet close animation.
  // react-remove-scroll applies a CSS class (.block-interactivity-N) with pointer-events: none
  // to <html> while the Sheet is open. Its React cleanup doesn't fire reliably after Radix
  // Presence unmounts the Sheet content, leaving all clicks on the page blocked.
  React.useEffect(() => {
    if (mobileSidebarOpen) return;
    const timer = setTimeout(() => {
      document.documentElement.style.pointerEvents = '';
      document.body.style.pointerEvents = '';
      for (const el of [document.documentElement, document.body]) {
        // Snapshot class list before mutating (removing during iteration)
        const classes = [...el.classList] as string[];
        for (const cls of classes) {
          if (cls.startsWith('block-interactivity')) el.classList.remove(cls);
        }
      }
    }, 350);
    return () => {
      clearTimeout(timer);
    };
  }, [mobileSidebarOpen]);

  // Radix cleanup — prevent stale body styles when component unmounts mid-transition
  React.useLayoutEffect(() => {
    return () => {
      document.body.style.overflow = '';
      document.body.style.pointerEvents = '';
      document.body.style.paddingRight = '';
      delete document.body.dataset['scrollLocked'];
    };
  }, []);

  function renderSidebarBody(): React.JSX.Element | null {
    if (isAuthenticated && isLoading) {
      return <SidebarLoadingIndicator collapsed={collapsed} />;
    }
    return (
      <SidebarContent
        conversations={isAuthenticated ? (conversations ?? []) : []}
        activeConversationId={activeConversationId}
        isAuthenticated={isAuthenticated}
        onLoadMore={fetchNextPage}
        hasMore={hasNextPage}
        isLoadingMore={isFetchingNextPage}
      />
    );
  }

  return (
    <SidebarPanel
      side="left"
      open={isMobile ? mobileSidebarOpen : true}
      onOpenChange={
        /* v8 ignore start -- desktop SidebarPanel renders a plain aside (never a Sheet), so the noop arm is never invoked; it exists only to satisfy the required prop */
        isMobile
          ? setMobileSidebarOpen
          : () => {
              /* noop — desktop sidebar always open */
            }
        /* v8 ignore stop */
      }
      collapsed={collapsed}
      ariaLabel="Conversations"
      headerIcon={
        <Link to={ROUTES.CHAT} aria-label="HushBox - Go to chat">
          <Logo />
        </Link>
      }
      onClose={
        isMobile
          ? () => {
              setMobileSidebarOpen(false);
            }
          : toggleSidebar
      }
      footer={<SidebarFooter />}
      testId={TEST_IDS.sidebar}
    >
      {renderSidebarBody()}
      {/* Last in the body, so the offer sits between the conversation list and
          the account footer. The 48px rail cannot carry the card's copy, so it
          carries a bell that expands the sidebar instead; the mobile drawer is
          full width and always gets the card. */}
      {collapsed ? <NotificationEnablePromptRail /> : <NotificationEnablePrompt />}
    </SidebarPanel>
  );
}
