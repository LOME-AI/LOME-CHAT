/**
 * The per-user active-DO/room set and the revocation fan-out over it
 * (ARCHITECTURE §15). A ConversationRoom DO records the rooms a real
 * authenticated user holds a live socket in; a session revocation reads that
 * set and closes the user's sockets in exactly those rooms. Packages never
 * import apps, so both the tracker (SADD/SREM) and the set reader (SMEMBERS)
 * are injected by the worker — this module owns the port shapes and the
 * pure fan-out only.
 */

/**
 * Tracks which conversation rooms a real authenticated user currently holds a
 * live socket in. Over-inclusion is safe — evicting a room the user no longer
 * occupies is a harmless no-op — while under-inclusion leaks plaintext, so
 * `track` is reliable at accept and `untrack` runs only when the user's last
 * socket in a room closes. Trial-session and link-guest principals are never
 * tracked; they hold no revocable session.
 */
export interface UserRoomTracker {
  track(userId: string, conversationId: string): Promise<void>;
  untrack(userId: string, conversationId: string): Promise<void>;
}

export interface UserRoomEvictionDeps {
  /** SMEMBERS of the user's active-room set: the conversationIds to fan out to. */
  readonly listRooms: (userId: string) => Promise<readonly string[]>;
  /** Close every socket the user holds in one room (the per-room DO evict). */
  readonly evictRoom: (conversationId: string, userId: string) => Promise<void>;
  /** Best-effort observability for a set-read or per-room evict failure. */
  readonly onError?: (context: string, cause: unknown) => void;
}

/**
 * Fans a session revocation out to every room the user holds a live socket in,
 * closing those sockets. This is the PROMPTNESS layer of a two-layer design:
 * it cuts the revoked user's sockets immediately instead of waiting for the
 * next broadcast. Best-effort and total: neither a failure reading the set nor
 * a failure evicting one room ever throws or aborts the others.
 *
 * The CORRECTNESS guarantee is the separate broadcast-time session-liveness
 * check (session-liveness.ts): a socket this fan-out misses — because the
 * active-room-set entry had expired (a connection held past its TTL) or the
 * per-room evict failed — is cut at its next broadcast, before any further
 * plaintext reaches it. The WS-upgrade re-auth additionally denies the revoked
 * session on any reconnect. The membership check is NOT a backstop for session
 * revocation: it validates conversation membership, not session validity, so a
 * revoked-but-still-member socket needs the session-liveness check to close.
 */
export async function evictUserFromRooms(
  userId: string,
  deps: UserRoomEvictionDeps
): Promise<void> {
  let rooms: readonly string[];
  try {
    rooms = await deps.listRooms(userId);
  } catch (error) {
    deps.onError?.(userId, error);
    return;
  }
  await Promise.all(
    rooms.map(async (conversationId) => {
      try {
        await deps.evictRoom(conversationId, userId);
      } catch (error) {
        deps.onError?.(conversationId, error);
      }
    })
  );
}
