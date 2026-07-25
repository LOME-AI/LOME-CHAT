import { useEffect } from 'react';
import { isAwayFromApp } from '@/lib/notification-activity/app-attention';
import { useNotificationActivityStore } from '@/stores/notification-activity';

/**
 * Resets the activity count when the user looks back at the app. Mounted once
 * at the app shell, alongside the feeds that fill the count.
 */
export function useActivityReset(): void {
  useEffect(() => {
    const onAttention = (): void => {
      // Both events also fire on the way out; only a return clears the count.
      if (isAwayFromApp()) return;
      useNotificationActivityStore.getState().markAllSeen();
    };
    window.addEventListener('focus', onAttention);
    document.addEventListener('visibilitychange', onAttention);
    return (): void => {
      window.removeEventListener('focus', onAttention);
      document.removeEventListener('visibilitychange', onAttention);
    };
  }, []);
}
