import { okAsync } from '../lib/result/index.js';
import { createConversationsStores } from '../slices/conversations/index.js';
import type { Database } from '@hushbox/db';
import type { DomainError } from '../lib/errors/index.js';
import type {
  ConversationFundingFacts,
  ConversationFundingReader,
} from '../slices/billing/index.js';

/**
 * The composition-root adapter behind billing's `ConversationFundingReader`.
 * The facts that name a group turn's payer live on conversations-owned rows
 * (`conversations.ownerUserId` + its durable cap, and the caller's
 * `conversation_members` row), while the money they gate lives on billing's
 * budget rows — no single slice may span both (single-writer-per-table), so the
 * two are composed here exactly as the presign readers are.
 *
 * `null` means "the caller's own wallet pays": the caller owns the conversation
 * (a solo turn), holds no active membership, or the conversation is gone. The
 * owner check comes first so an owner who also carries a membership row is never
 * priced against their own member budget.
 */
export function createConversationFundingReader(db: Database): ConversationFundingReader {
  const stores = createConversationsStores(db);
  return ({ conversationId, callerUserId }) =>
    stores.conversations.get(conversationId).andThen((conversation) => {
      if (conversation === null || conversation.ownerUserId === callerUserId) {
        return okAsync<ConversationFundingFacts | null, DomainError>(null);
      }
      return stores.members.activeByUser(conversationId, callerUserId).map((member) =>
        member === null
          ? null
          : {
              conversationId,
              memberId: member.id,
              ownerUserId: conversation.ownerUserId,
              conversationBudgetNanoUsd: conversation.conversationBudgetNanoUsd,
            }
      );
    });
}
