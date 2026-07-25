import * as React from 'react';
import { useNotificationActivityStore } from '@/stores/notification-activity';

/**
 * The activity count as words, for people who cannot see a badge or a tab
 * title. Sound is opt-in and the badge may not exist on this platform, so this
 * region is what keeps the signal from ever being visual-only.
 */
export function ActivityAnnouncer(): React.JSX.Element {
  const unreadCount = useNotificationActivityStore((state) => state.unreadCount);
  const plural = unreadCount === 1 ? '' : 's';
  const message = unreadCount > 0 ? `${String(unreadCount)} new notification${plural}` : '';

  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
      {message}
    </div>
  );
}
