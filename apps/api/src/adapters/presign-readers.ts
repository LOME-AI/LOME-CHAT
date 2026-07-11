import { okAsync } from '../lib/result/index.js';
import { findContentItemForPresign } from '../slices/chat/index.js';
import {
  findMessageShare,
  isActiveConversationMember,
  isEpochMember,
  resolveEpochRowId,
} from '../slices/conversations/index.js';
import type { Database } from '@hushbox/db';
import type { DomainError } from '../lib/errors/index.js';
import type { MediaTarget, PresignReaders } from '../slices/media/index.js';

/**
 * The composition-root adapter behind media's `PresignReaders`. It is the ONE
 * place chat's and conversations' published reads are composed: `findMediaTarget`
 * spans chat-owned `content_items`/`messages` AND conversations-owned `epochs`,
 * which no single slice may query (single-writer-per-table). Media's domain runs
 * the authorization on this reader set without ever touching a table itself,
 * mirroring how the link-resolution adapter and the GC media-reference reader are
 * root-composed.
 */
export function createPresignReaders(db: Database): PresignReaders {
  return {
    contentItems: {
      // Chat resolves the item to its conversation + epoch NUMBER; conversations
      // resolves that number to the epoch ROW id media's gate needs. A missing
      // item, or an epoch that cannot be resolved, answers null so media denies
      // blind rather than presigning against a half-resolved target.
      findMediaTarget: (contentItemId) =>
        findContentItemForPresign(db, contentItemId).andThen((row) => {
          if (row === null) return okAsync<MediaTarget | null, DomainError>(null);
          return resolveEpochRowId(db, row.conversationId, row.epochNumber).map((epochId) =>
            epochId === null
              ? null
              : {
                  contentItemId: row.contentItemId,
                  conversationId: row.conversationId,
                  epochId,
                  contentType: row.contentType,
                  storageKey: row.storageKey,
                }
          );
        }),
    },
    membership: {
      isActiveMember: (conversationId, member) =>
        isActiveConversationMember(db, conversationId, member),
      isEpochMember: (epochId, member) => isEpochMember(db, epochId, member),
    },
    shares: {
      findShare: (shareId) => findMessageShare(db, shareId),
    },
  };
}
