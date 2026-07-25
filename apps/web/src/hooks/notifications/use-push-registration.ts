import { useEffect, useRef } from 'react';
import { notificationChannel } from '@/lib/notification-channel';
import { useStableSession } from '@/hooks/auth/use-stable-session';
import { useNotificationPreferences } from '@/hooks/notifications/use-notification-preferences';

/**
 * Re-registers this device for push once per authenticated app start.
 *
 * Registration is an upsert, so re-running it is how a rotated browser
 * subscription or a server-pruned row heals — there is no separate repair path.
 * It is skipped while the account-level switch is off: turning that switch off
 * unregisters the device, and re-registering on the next start would undo it.
 */
export function usePushRegistration(): void {
  const { isAuthenticated } = useStableSession();
  const { data: preferences } = useNotificationPreferences();
  const attempted = useRef(false);

  useEffect(() => {
    if (attempted.current) return;
    if (!isAuthenticated || preferences?.globalEnabled !== true) return;
    attempted.current = true;
    void (async (): Promise<void> => {
      try {
        await notificationChannel.ensureRegistered();
      } catch {
        // Best-effort: push is not load-bearing, and the next app start retries.
      }
    })();
  }, [isAuthenticated, preferences]);
}
