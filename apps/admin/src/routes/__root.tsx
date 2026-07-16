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
import type { RouterContext } from '@/router';

function RootComponent(): React.JSX.Element {
  return (
    <MotionProvider>
      <QueryProvider>
        <A11yProvider>
          <OpModalProvider>
            <PaletteProvider>
              <div
                data-testid={TEST_IDS.adminShell}
                className="bg-background text-foreground flex h-dvh overflow-hidden"
              >
                <AdminNav />
                <div className="flex min-w-0 flex-1 flex-col">
                  <AdminTopbar />
                  <main className="min-h-0 flex-1 overflow-y-auto">
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
  );
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootComponent,
});
