/**
 * "Ask me later, forever" is deliberately device-local: push permission is
 * granted per browser and per install, so a server-persisted flag would
 * suppress the prompt on a device that never had the chance to answer it.
 */
const DISMISSED_KEY = 'hb:notif-prompt-dismissed';

export function isPromptDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) !== null;
  } catch {
    // Storage can be blocked entirely (private mode, disabled cookies);
    // showing the prompt is the safe answer.
    return false;
  }
}

export function markPromptDismissed(): void {
  try {
    localStorage.setItem(DISMISSED_KEY, 'true');
  } catch {
    // A device that cannot persist the choice still gets the prompt hidden for
    // this session, and nothing else depends on the write.
  }
}
