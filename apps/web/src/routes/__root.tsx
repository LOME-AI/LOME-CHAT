import * as React from 'react';
import { Outlet, createRootRouteWithContext, Navigate } from '@tanstack/react-router';
import { ROUTES } from '@hushbox/shared';
import { Toaster, TouchDeviceOverrideContext } from '@hushbox/ui';
import { A11yProvider, MotionProvider } from '@hushbox/ui/accessibility';
import { QueryProvider } from '@/providers/query-provider';
import { StabilityProvider, useStability } from '@/providers/stability-provider';
import { ThemeProvider } from '@/providers/theme-provider';
import { CapacitorProvider } from '@/capacitor';
import { UpgradeRequiredModal } from '@/components/shared/upgrade-required-modal';
import { OfflineOverlay } from '@/components/shared/offline-overlay';
import { SettledIndicator } from '@/components/shared/settled-indicator';
import { RouteAnnouncer } from '@/components/shared/route-announcer';
import { AnnouncementBanner } from '@/components/banner/announcement-banner';
import { CrawlerEye } from '@/components/dev/crawler-eye';
import { useTouchOverrideStore } from '@/stores/touch-override';
import { installTtsDomObserver } from '@/lib/tts-dom-observer';
import type { RouterContext } from '@/router';

function NotFoundRedirect(): React.JSX.Element {
  return <Navigate to={ROUTES.CHAT} />;
}

function AppShell(): React.JSX.Element {
  const { isAppStable } = useStability();
  return (
    <CapacitorProvider isAppStable={isAppStable}>
      {/* Flex column so the banner is a non-growing row above all route content.
          When no banner is active the mount node is empty (height 0), so this is
          a no-op for the common case. */}
      <div className="flex h-dvh flex-col">
        <AnnouncementBanner />
        <div className="min-h-0 flex-1 overflow-y-auto">
          <RouteAnnouncer />
          <Outlet />
        </div>
      </div>
      <Toaster />
      <SettledIndicator />
      <UpgradeRequiredModal />
      <OfflineOverlay />
      <CrawlerEye />
    </CapacitorProvider>
  );
}

function RootComponent(): React.JSX.Element {
  const touchOverride = useTouchOverrideStore((state) => state.override);

  // Self-applying streaming TTS — any current or future surface that wraps its
  // streamed text in a [data-tts-stream] container gets chat-aloud automatically.
  // Complements the explicit `chat-tts-stream.ts` wiring inside `executeStream`.
  React.useEffect(() => installTtsDomObserver(), []);

  return (
    <TouchDeviceOverrideContext value={touchOverride}>
      <MotionProvider>
        <ThemeProvider>
          <QueryProvider>
            <StabilityProvider>
              <A11yProvider>
                <AppShell />
              </A11yProvider>
            </StabilityProvider>
          </QueryProvider>
        </ThemeProvider>
      </MotionProvider>
    </TouchDeviceOverrideContext>
  );
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootComponent,
  notFoundComponent: NotFoundRedirect,
});
