import * as React from 'react';
import { ActivityAnnouncer } from '@/components/notifications/activity-announcer';
import { useActivityReset } from '@/hooks/notifications/use-activity-reset';
import { useActivitySinks } from '@/hooks/notifications/use-activity-sinks';
import { useClearReadElsewhere } from '@/hooks/notifications/use-notification-clearing';

/**
 * The foreground half of notifications, mounted once in the app shell: it
 * presents the observed-activity count, clears it when the user returns, and
 * tidies away notifications for conversations read on another device.
 */
export function NotificationActivityLayer(): React.JSX.Element {
  useActivityReset();
  useActivitySinks();
  useClearReadElsewhere();

  return <ActivityAnnouncer />;
}
