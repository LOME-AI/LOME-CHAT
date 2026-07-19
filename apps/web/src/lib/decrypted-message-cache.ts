/**
 * Per-message decrypted-content cache, keyed by `conversationId:messageId`.
 *
 * Realtime invalidation (use-realtime-sync) refetches the conversation on
 * every inbound event, producing a fresh `messages` array reference each
 * time. Without this cache the decrypt hook would re-decrypt the entire
 * history synchronously on the main thread per event. The cache lets unchanged
 * messages reuse their plaintext so only NEW or epoch-rotated messages
 * decrypt.
 *
 * `epochNumber` is stored alongside the plaintext: a message that rotates to
 * a new epoch must re-decrypt (its content key is now sealed under a
 * different epoch key), so a stale-epoch hit is treated as a miss.
 *
 * This holds decrypted PLAINTEXT at module scope. It lives in its own leaf
 * module (imported by both the decrypt hook and auth teardown) so that
 * `clearLocalAuthState` can drop it on sign-out without a module import cycle.
 */
export interface DecryptedEntry {
  epochNumber: number;
  content: string;
}

export const decryptedCache = new Map<string, DecryptedEntry>();

export function decryptedCacheKey(conversationId: string, messageId: string): string {
  return `${conversationId}:${messageId}`;
}

/** Clears the per-message decrypted-content cache. */
export function clearDecryptedMessageCache(): void {
  // The cache is populated by importers (the decrypt hook); this module only
  // declares and clears it, so sonarjs wrongly sees it as always empty here.
  // eslint-disable-next-line sonarjs/no-empty-collection -- populated by importers, see above
  decryptedCache.clear();
}
