import { Button } from '@hushbox/ui';
import { useEnablePrompt } from '@/hooks/notifications/use-enable-prompt';
import type * as React from 'react';

/**
 * The one-time offer to turn on notifications for this device.
 *
 * An inline region rather than a modal: it announces politely, never takes
 * focus, and both answers are ordinary buttons. It is offered once per device —
 * "Later" is permanent there — so the copy points at Settings, which stays the
 * place to change the answer.
 *
 * It renders in the sidebar column, so the card stacks: heading, then the
 * promise about content, then the two answers side by side. Nothing here
 * depends on a width wider than the sidebar's.
 */
export function NotificationEnablePrompt(): React.JSX.Element | null {
  const { isVisible, isEnabling, enable, dismiss } = useEnablePrompt();

  if (!isVisible) return null;

  return (
    <div
      role="status"
      className="border-sidebar-border bg-card mt-2 flex shrink-0 flex-col gap-2 rounded-lg border p-3"
    >
      <h2 className="text-sm font-medium">Turn on notifications</h2>
      <p className="text-muted-foreground text-xs leading-relaxed">
        Know when a reply lands or a run finishes, even when HushBox is closed. Never includes
        message content. Change this any time in Settings.
      </p>
      <div className="flex gap-2">
        <Button size="sm" className="flex-1" onClick={enable} disabled={isEnabling}>
          Enable
        </Button>
        <Button size="sm" variant="ghost" className="flex-1" onClick={dismiss}>
          Later
        </Button>
      </div>
    </div>
  );
}
