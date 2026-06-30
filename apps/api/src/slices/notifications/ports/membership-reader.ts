import type { ResultAsync } from '../../../lib/result/index.js';
import type { DomainError } from '../../../lib/errors/index.js';

export interface ConversationMemberView {
  readonly userId: string;
  readonly muted: boolean;
}

/**
 * Narrow read-only view of a conversation's active user members (mute flag
 * included) for push-recipient selection. `conversation_members` belongs to
 * the conversations slice (single-writer; slice code references only its own
 * schema objects), so this port is bound at composition to that slice's
 * published surface once its barrel lands — this slice never queries the
 * table itself.
 */
export interface MembershipReader {
  /** Active user members only: leftAt null, userId non-null (link guests carry no devices). */
  listActiveUserMembers(
    conversationId: string
  ): ResultAsync<readonly ConversationMemberView[], DomainError>;
}
