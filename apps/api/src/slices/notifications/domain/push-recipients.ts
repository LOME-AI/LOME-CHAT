import type { ConversationMemberView } from '../ports/index.js';

export interface SelectPushRecipientsParams {
  readonly members: readonly ConversationMemberView[];
  /** Users with an open socket on the conversation — they see the message inline. */
  readonly presentUserIds: readonly string[];
  readonly senderUserId: string;
}

/**
 * Push goes only to members who would otherwise miss the message: muted
 * members opted out, present members already see it live, and the sender
 * wrote it.
 */
export function selectPushRecipients(params: SelectPushRecipientsParams): readonly string[] {
  const present = new Set(params.presentUserIds);
  return params.members
    .filter(
      (member) =>
        !member.muted && member.userId !== params.senderUserId && !present.has(member.userId)
    )
    .map((member) => member.userId);
}
