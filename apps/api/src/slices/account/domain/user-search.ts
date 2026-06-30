import { z } from 'zod';
import { normalizeUsername, toBase64 } from '@hushbox/shared';
import { forbiddenError } from '../../../lib/errors/index.js';
import { errAsync } from '../../../lib/result/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { UserDirectory } from '../ports/index.js';

export const USER_SEARCH_MAX_RESULTS = 20;

export const searchUsersQuerySchema = z.object({
  q: z.string().min(1).max(50),
  conversationId: z.uuid(),
  limit: z.coerce.number().int().min(1).max(USER_SEARCH_MAX_RESULTS).optional(),
});

export interface InvitableUser {
  readonly id: string;
  readonly username: string;
  /** base64 (URL-safe) — the invite flow wraps epoch keys to this key. */
  readonly publicKey: string;
}

/**
 * Escapes LIKE metacharacters so the prefix matches literally. Normalized
 * usernames contain `_` (spaces collapse to underscores), which is a LIKE
 * single-character wildcard — unescaped, searching "john d" would also match
 * "johnxd". The legacy search did not escape; this is a deliberate fix.
 */
export function escapeLikePrefix(prefix: string): string {
  return prefix.replaceAll('\\', String.raw`\\`).replaceAll(/[%_]/g, String.raw`\$&`);
}

export function searchInvitableUsers(
  users: UserDirectory,
  params: {
    readonly query: string;
    readonly conversationId: string;
    readonly callerUserId: string;
    readonly limit?: number;
  }
): ResultAsync<readonly InvitableUser[], DomainError> {
  const pattern = `${escapeLikePrefix(normalizeUsername(params.query))}%`;
  // Authorization gate: the conversationId is client-supplied, so without
  // this check the member exclusion in the search would let any session user
  // probe another conversation's membership. A former member (leftAt set) is
  // a non-member here. A nonexistent conversation answers the same forbidden,
  // so the response is not an existence oracle either.
  return users
    .isActiveMember({ conversationId: params.conversationId, userId: params.callerUserId })
    .andThen((isMember): ResultAsync<readonly InvitableUser[], DomainError> => {
      if (!isMember) {
        return errAsync(forbiddenError('user search: caller is not an active conversation member'));
      }
      return users
        .searchInvitable({
          usernamePattern: pattern,
          excludeUserId: params.callerUserId,
          conversationId: params.conversationId,
          limit: params.limit ?? USER_SEARCH_MAX_RESULTS,
        })
        .map((rows) =>
          rows.map((row) => ({
            id: row.id,
            username: row.username,
            publicKey: toBase64(row.publicKey),
          }))
        );
    });
}
