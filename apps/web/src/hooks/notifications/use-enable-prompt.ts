import { useCallback, useEffect, useState } from 'react';
import {
  notificationChannel,
  isPromptDismissed,
  markPromptDismissed,
} from '@/lib/notification-channel';
import { useNotificationPreferences } from '@/hooks/notifications/use-notification-preferences';
import type { PushPermissionState } from '@/lib/notification-channel';

export interface EnablePromptState {
  /** True only while every condition for offering push on this device holds. */
  isVisible: boolean;
  /** True between the user's click and the platform's answer. */
  isEnabling: boolean;
  enable: () => void;
  dismiss: () => void;
}

async function readPermission(): Promise<PushPermissionState> {
  try {
    return await notificationChannel.getPermissionState();
  } catch {
    // An unreadable permission means no offer: guessing `default` would surface
    // a prompt the platform is going to refuse.
    return 'unsupported';
  }
}

async function requestPermission(): Promise<PushPermissionState> {
  try {
    return await notificationChannel.requestPermissionAndRegister();
  } catch {
    // The grant can land and registration still fail (offline, server error).
    // Re-read the platform instead of assuming an outcome.
    return await notificationChannel.getPermissionState();
  }
}

/**
 * Decides whether this device should be offered push, and drives the answer.
 *
 * The offer is made at most once per device: it is suppressed when the person
 * already answered the platform prompt (granted or denied), when the device has
 * no push path at all, when they chose "later" here before, and when the
 * account-level switch is off. The permission question itself is only ever
 * raised from `enable()` — mounting this hook never prompts.
 */
export function useEnablePrompt(): EnablePromptState {
  const { data: preferences } = useNotificationPreferences();
  const [dismissed, setDismissed] = useState<boolean>(() => isPromptDismissed());
  const [permission, setPermission] = useState<PushPermissionState | null>(null);
  const [isEnabling, setIsEnabling] = useState(false);

  const eligible = !dismissed && preferences?.globalEnabled === true;

  useEffect(() => {
    if (!eligible || permission !== null) return;
    const state = { cancelled: false };
    void (async (): Promise<void> => {
      const next = await readPermission();
      if (!state.cancelled) setPermission(next);
    })();
    return () => {
      state.cancelled = true;
    };
  }, [eligible, permission]);

  const enable = useCallback((): void => {
    setIsEnabling(true);
    void (async (): Promise<void> => {
      try {
        setPermission(await requestPermission());
      } catch {
        // Platform unreachable: leave the offer standing so it can be retried.
      } finally {
        setIsEnabling(false);
      }
    })();
  }, []);

  const dismiss = useCallback((): void => {
    markPromptDismissed();
    setDismissed(true);
  }, []);

  return { isVisible: eligible && permission === 'default', isEnabling, enable, dismiss };
}
