import { Bell } from 'lucide-react';
import { Button } from '@hushbox/ui';
import { useUIStore } from '@/stores/ui';
import { useEnablePrompt } from '@/hooks/notifications/use-enable-prompt';
import type * as React from 'react';

/**
 * The collapsed-rail stand-in for the one-time notification offer.
 *
 * The rail is 48px wide, so the card's copy cannot live there — but the
 * sidebar starts collapsed, so dropping the offer entirely would hide it from
 * every first-time desktop user. This keeps a labelled bell in the rail that
 * expands the sidebar, where the card itself is waiting.
 *
 * It answers to the same `useEnablePrompt` state as the card, so both appear
 * and retire together; expanding is navigation, never an answer to the offer.
 */
export function NotificationEnablePromptRail(): React.JSX.Element | null {
  const { isVisible } = useEnablePrompt();
  const toggleSidebar = useUIStore((state) => state.toggleSidebar);

  if (!isVisible) return null;

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      onClick={toggleSidebar}
      aria-label="Turn on notifications"
      className="relative mt-2 shrink-0 self-center"
    >
      <Bell className="h-4 w-4" aria-hidden="true" />
      <span
        aria-hidden="true"
        className="bg-primary absolute top-1 right-1 h-1.5 w-1.5 rounded-full"
      />
    </Button>
  );
}
