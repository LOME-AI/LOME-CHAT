import * as React from 'react';
import { useParams } from '@tanstack/react-router';
import { TEST_IDS } from '@hushbox/shared';
import { Sidebar } from '@/components/sidebar/sidebar';
import { NotificationActivityLayer } from '@/components/notifications/notification-activity-layer';
import { useModelValidation } from '@/hooks/models/use-model-validation';
import { usePushRegistration } from '@/hooks/notifications/use-push-registration';

interface AppShellProps {
  children: React.ReactNode;
}

/**
 * The conversation whose owner funds what is composed under the shell, or
 * `null` when there is none. The shell renders on every route, so the params
 * are read non-strictly: `$id` on the chat route and `$conversationId` on the
 * share route, which is where a link guest — funded by the owner — arrives.
 * `new` is the placeholder for a conversation that does not exist yet, whose
 * payer is the caller.
 */
function useShellConversationId(): string | null {
  const params = useParams({ strict: false });
  const id = params.conversationId ?? params.id;
  return id === undefined || id === 'new' ? null : id;
}

export function AppShell({ children }: Readonly<AppShellProps>): React.JSX.Element {
  useModelValidation(useShellConversationId());
  usePushRegistration();

  return (
    <div data-testid={TEST_IDS.appShell} className="bg-background flex h-full">
      {/* Skip link: first focusable element so keyboard/SR users can jump past
          the sidebar to the main content (WCAG 2.4.1). Visually hidden until
          focused, then revealed via focus:not-sr-only. */}
      <a
        href="#main"
        className="bg-background text-foreground sr-only z-50 rounded-md px-4 py-2 focus:not-sr-only focus:absolute focus:top-2 focus:left-2"
      >
        Skip to content
      </a>

      {/* Renders only a screen-reader live region; it exists here so the
          activity count, tab title, and app badge have one owner for the whole
          authenticated app. */}
      <NotificationActivityLayer />

      <Sidebar />

      {/* Main content area — min-h-0 prevents flex items from inheriting their
          children's min-content height and pushing past the height allocated by
          the root route's h-dvh banner-row layout (the shell is h-full inside
          its flex-1 region, paired with the html/body overflow-hidden cap in
          app.css). id + tabIndex make it the skip link's focus target. */}
      <main id="main" tabIndex={-1} className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {children}
      </main>

      {/* Portal target for right sidebar — display:contents makes it invisible to flex layout */}
      <div id="right-sidebar-portal" className="contents" />
    </div>
  );
}
