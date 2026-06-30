import { eq, and, ne, isNull, ilike, asc } from 'drizzle-orm';
import { users, conversationMembers, type Database } from '@hushbox/db';
import { toBase64, normalizeUsername } from '@hushbox/shared';

export interface UserSearchResult {
  id: string;
  username: string;
  publicKey: string;
}

const MAX_LIMIT = 20;

/**
 * Search users by username prefix with case-insensitive matching.
 * Excludes the requesting user. Optionally excludes users who are
 * active members of a given conversation.
 */
export async function searchUsers(
  db: Database,
  query: string,
  requesterId: string,
  options?: { excludeConversationId?: string; limit?: number }
): Promise<UserSearchResult[]> {
  const limit = Math.min(options?.limit ?? MAX_LIMIT, MAX_LIMIT);
  const normalizedQuery = normalizeUsername(query);

  if (options?.excludeConversationId) {
    const rows = await db
      .select({
        id: users.id,
        username: users.username,
        publicKey: users.publicKey,
      })
      .from(users)
      .leftJoin(
        conversationMembers,
        and(
          eq(conversationMembers.userId, users.id),
          eq(conversationMembers.conversationId, options.excludeConversationId),
          isNull(conversationMembers.leftAt)
        )
      )
      .where(
        and(
          ilike(users.username, `${normalizedQuery}%`),
          ne(users.id, requesterId),
          isNull(conversationMembers.id)
        )
      )
      .orderBy(asc(users.username))
      .limit(limit);

    return rows.map((r) => ({
      id: r.id,
      username: r.username,
      publicKey: toBase64(r.publicKey),
    }));
  }

  const rows = await db
    .select({
      id: users.id,
      username: users.username,
      publicKey: users.publicKey,
    })
    .from(users)
    .where(and(ilike(users.username, `${normalizedQuery}%`), ne(users.id, requesterId)))
    .orderBy(asc(users.username))
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    username: r.username,
    publicKey: toBase64(r.publicKey),
  }));
}
