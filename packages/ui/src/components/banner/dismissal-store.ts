import { BANNER_DISMISSED_STORAGE_KEY } from '@hushbox/shared';

/**
 * Local dismissal state for the announcement banner.
 *
 * The stored value is the dismissed message-set hash, not a boolean: the banner
 * is dismissed only while the stored hash equals the current set's hash, so a new
 * set re-shows automatically. The key is written ONLY on dismiss — a "not
 * dismissed" state is the absence of the key, never a stored `false` — which is
 * what lets the fast path ("local says dismissed") skip the server entirely
 * without risking a stale negative.
 *
 * Every access is guarded: `localStorage` is absent under Astro SSR and throws in
 * some private-browsing modes, and a dismissal is best-effort, so failures
 * degrade to "not dismissed" / "couldn't persist" rather than breaking the page.
 */
function getStorage(): Storage | null {
  try {
    // `localStorage` is absent under Astro SSR; the cast lets the nullish guard stand.
    const storage = (globalThis as { localStorage?: Storage }).localStorage;
    return storage ?? null;
  } catch {
    return null;
  }
}

export function readDismissedBannerHash(): string | null {
  const storage = getStorage();
  if (!storage) return null;
  try {
    return storage.getItem(BANNER_DISMISSED_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function isBannerDismissed(hash: string): boolean {
  return readDismissedBannerHash() === hash;
}

export function markBannerDismissed(hash: string): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(BANNER_DISMISSED_STORAGE_KEY, hash);
  } catch {
    // Best-effort: quota/private-mode failures are non-fatal.
  }
}
