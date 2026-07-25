/**
 * Mirror the activity count onto the OS app icon where the platform offers a
 * badge (installed PWA, desktop Chrome/Safari). Android browsers have no Badging
 * API at all, so the absence of the methods is the normal case, not an error.
 *
 * Zero always routes through `clearAppBadge()`: Safari treats `setAppBadge(0)`
 * as "hide the badge" while Chromium shows a dot, and one deterministic call
 * keeps both platforms on the same behavior.
 */
export function applyAppBadge(count: number): void {
  if (!('setAppBadge' in navigator) || !('clearAppBadge' in navigator)) return;
  const applied = count > 0 ? navigator.setAppBadge(count) : navigator.clearAppBadge();
  void (async (): Promise<void> => {
    try {
      await applied;
    } catch {
      // Badging rejects on platforms that expose the API but refuse the write
      // (an uninstalled PWA, a revoked permission). Nothing depends on the badge.
    }
  })();
}
