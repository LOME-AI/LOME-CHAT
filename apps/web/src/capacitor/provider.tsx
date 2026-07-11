import { useCallback, useRef } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { fetchJson, client } from '../lib/api-client.js';
import { getPlatform } from './platform.js';
import { useBackButton } from './hooks/use-back-button.js';
import { useDeepLinks } from './hooks/use-deep-links.js';
import { useAppLifecycle } from './hooks/use-app-lifecycle.js';
import { useNetworkStatus } from './hooks/use-network-status.js';
import { useSplashScreen } from './hooks/use-splash-screen.js';
import { usePushNotifications } from './hooks/use-push-notifications.js';
import { useLiveUpdate } from './hooks/use-live-update.js';
import type * as React from 'react';

interface CapacitorProviderProps {
  isAppStable: boolean;
}

// Conversation ids are server-generated UUIDs (uuidv7). Push payloads are
// untrusted, so the id is validated against this shape before it is
// interpolated into a navigation path — blocking traversal/token injection.
const CONVERSATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Thin shell that activates all Capacitor hooks.
 *
 * Each hook guards itself with `isNative()`, so this provider is safe to
 * render on web — all hooks become no-ops.
 */
export function CapacitorProvider({
  isAppStable,
  children,
}: Readonly<React.PropsWithChildren<CapacitorProviderProps>>): React.JSX.Element {
  const navigate = useNavigate();
  const handleDeepLink = useCallback(
    (path: string) => {
      void navigate({ to: path });
    },
    [navigate]
  );

  // Stable ref for device token registration (fire-and-forget)
  const registerTokenRef = useRef(async (token: string): Promise<void> => {
    const platform = getPlatform();
    // API accepts 'ios' | 'android' — map 'android-direct' → 'android'
    const apiPlatform: 'ios' | 'android' = platform === 'ios' ? 'ios' : 'android';
    await fetchJson(
      client.notifications['device-tokens'].$post({ json: { token, platform: apiPlatform } })
    );
  });

  const handleTokenReceived = useCallback((token: string) => {
    void registerTokenRef.current(token);
  }, []);

  const handleNotificationTap = useCallback(
    (data: Record<string, string>) => {
      const conversationId = data['conversationId'];
      if (conversationId && CONVERSATION_ID_PATTERN.test(conversationId)) {
        void navigate({ to: `/chat/${conversationId}` });
      }
    },
    [navigate]
  );

  useBackButton();
  useDeepLinks(handleDeepLink);
  useAppLifecycle();
  useNetworkStatus();
  useSplashScreen(isAppStable);
  useLiveUpdate();
  usePushNotifications({
    onTokenReceived: handleTokenReceived,
    onNotificationTap: handleNotificationTap,
  });

  return <>{children}</>;
}
