import * as React from 'react';
import { TEST_IDS } from '@hushbox/shared';
import { Sidebar } from '@/components/sidebar/sidebar';
import { useModelValidation } from '@/hooks/models/use-model-validation';

interface AppShellProps {
  children: React.ReactNode;
}

export function AppShell({ children }: Readonly<AppShellProps>): React.JSX.Element {
  useModelValidation();

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

      <Sidebar />

      {/* Main content area — min-h-0 prevents flex items from inheriting their
          children's min-content height and pushing past the allocated h-dvh
          (paired with the html/body overflow-hidden cap in app.css).
          id + tabIndex make it the skip link's focus target. */}
      <main id="main" tabIndex={-1} className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {children}
      </main>

      {/* Portal target for right sidebar — display:contents makes it invisible to flex layout */}
      <div id="right-sidebar-portal" className="contents" />
    </div>
  );
}
