import * as React from 'react';
import { Outlet, createRootRouteWithContext } from '@tanstack/react-router';
import { A11yProvider, MotionProvider } from '@hushbox/ui/accessibility';
import { TEST_IDS } from '@hushbox/shared';
import { QueryProvider } from '@/providers/query-provider';
import { AdminNav } from '@/components/shell/admin-nav';
import { AdminTopbar } from '@/components/shell/admin-topbar';
import { OpModalProvider } from '@/components/ops/op-modal-provider';
import { CommandPalette } from '@/components/palette/command-palette';
import { PaletteProvider } from '@/components/palette/palette-provider';
import { AdminErrorBoundary } from '@/components/util/error-boundary';
import type { RouterContext } from '@/router';

function RootComponent(): React.JSX.Element {
  return (
    <AdminErrorBoundary>
      <MotionProvider>
        <QueryProvider>
          <A11yProvider>
            <OpModalProvider>
              <PaletteProvider>
                <div
                  data-testid={TEST_IDS.adminShell}
                  className="bg-background text-foreground flex h-dvh overflow-hidden"
                >
                  {/* Skip link: first focusable element so keyboard/SR users can
                      jump past the nav and topbar to the main content (WCAG
                      2.4.1). Visually hidden until focused, then revealed via
                      focus:not-sr-only. Mirrors the web app shell. */}
                  <a
                    href="#main"
                    className="bg-background text-foreground sr-only z-50 rounded-md px-4 py-2 focus:not-sr-only focus:absolute focus:top-2 focus:left-2"
                  >
                    Skip to content
                  </a>
                  <AdminNav />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <AdminTopbar />
                    {/* id + tabIndex make main the skip link's focus target. */}
                    <main id="main" tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto">
                      <Outlet />
                    </main>
                  </div>
                </div>
                <CommandPalette />
              </PaletteProvider>
            </OpModalProvider>
          </A11yProvider>
        </QueryProvider>
      </MotionProvider>
    </AdminErrorBoundary>
  );
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootComponent,
});
