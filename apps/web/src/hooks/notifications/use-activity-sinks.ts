import { useEffect, useRef } from 'react';
import { applyAppBadge } from '@/lib/notification-activity/app-badge';
import { playNotificationSound } from '@/lib/notification-activity/sound';
import { useNotificationActivityStore } from '@/stores/notification-activity';

/**
 * Presents the activity count through every channel the platform offers: the
 * tab title, the OS app badge, and the opt-in chime. Mounted once, at the app
 * shell — this effect is the single writer of `document.title`, so nothing else
 * may set it.
 */
export function useActivitySinks(): void {
  const unreadCount = useNotificationActivityStore((state) => state.unreadCount);
  const soundEnabled = useNotificationActivityStore((state) => state.soundEnabled);
  const baseTitle = useRef('');
  const previousCount = useRef(unreadCount);

  // Declared before the count effect so the plain title is captured before
  // anything prefixes it; the cleanup hands it back when the layer goes away.
  useEffect(() => {
    const base = document.title;
    baseTitle.current = base;
    return (): void => {
      document.title = base;
    };
  }, []);

  useEffect(() => {
    document.title =
      unreadCount > 0 ? `(${String(unreadCount)}) ${baseTitle.current}` : baseTitle.current;
  }, [unreadCount]);

  useEffect(() => {
    applyAppBadge(unreadCount);
  }, [unreadCount]);

  useEffect(() => {
    const arrived = unreadCount > previousCount.current;
    previousCount.current = unreadCount;
    // Sound is a companion to the badge and the announcement, never the only
    // signal, and it only marks new arrivals — not a count being cleared.
    if (arrived && soundEnabled) playNotificationSound();
  }, [unreadCount, soundEnabled]);
}
