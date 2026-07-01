/**
 * Client-side persistence keys (browser localStorage / Zustand persist `name`).
 *
 * Keys consumed by more than one package live here so the web app and the e2e
 * suite share a single source of truth — a rename then breaks both at the type
 * level instead of silently orphaning persisted state or a test seed.
 *
 * Store-local keys with no cross-package consumer may stay literals in their
 * store file; promote them here when something outside the web app needs them.
 */

/** Zustand persist key for the web-search preference store (`stores/search.ts`). */
export const WEB_SEARCH_STORAGE_KEY = 'hushbox-search-storage';

/**
 * Announcement-banner dismissal key. Its value is the dismissed message-set hash,
 * not a boolean: the banner is dismissed only while the stored hash equals the
 * current set's hash, so a new set (new hash) re-shows automatically with no
 * stale-key cleanup. Written only on dismiss — a "not dismissed" state is the
 * absence of this key, never a stored `false`. Shared by the web app and the
 * Astro site, hence the dotted, versioned cross-app key shape.
 */
export const BANNER_DISMISSED_STORAGE_KEY = 'hushbox.banner.dismissed.v1';
