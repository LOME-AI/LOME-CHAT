import { okAsync } from '../../../lib/result/index.js';
import type { ConversationsStores, SenderChainRow } from '../../conversations/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';

/**
 * The regenerate/edit guard. A regenerate re-runs a turn from an anchor user
 * message, deleting the reply(s) below it — so in a GROUP chat it must never
 * delete across another member's intervening message. Solo chats are always
 * safe (no other member can have intervened). This gate runs BEFORE the paid
 * run starts, so a blocked regenerate never admits or charges.
 */

export interface CanRegenerateParams {
  readonly conversationId: string;
  readonly targetMessageId: string;
  readonly userId: string;
  /** Resolve the tip from this fork when set; otherwise the linear high-sequence tip. */
  readonly forkId?: string | undefined;
  /**
   * The single assistant reply a retry-one deletes. When set it MUST be a direct
   * assistant reply of `targetMessageId`, or the settlement's unscoped
   * `deleteMessagesByIdWithinTx([replaceAssistantId])` would delete an arbitrary
   * message — including a co-member's. Absent for retry-all and edit.
   */
  readonly replaceAssistantId?: string | undefined;
}

/**
 * The pre-run verdict. `target-missing` (404) and `invalid-replace` (404, the
 * named reply is not a direct assistant reply of the anchor) both reject a bad
 * delete target; `fork-required` rejects a no-forkId regenerate on a conversation
 * that has forks (the linear sequence-delete is unsafe once branches share the
 * sequence space); `blocked` (403) refuses deleting across another member's
 * message. Only `allowed` proceeds to admission.
 */
export type RegenerateDecision =
  | 'allowed'
  | 'blocked'
  | 'target-missing'
  | 'invalid-replace'
  | 'fork-required';

/**
 * Pure walk from `tipMessageId` up to (exclusive of) `targetMessageId` via
 * `parentMessageId`. Returns true — BLOCK — when a `user` message from a
 * DIFFERENT, still-attributed sender sits on that path. An assistant message is
 * skipped (only users intervene); a null `senderId` (a deleted account, scrubbed
 * to null) counts as nobody. The walk is bounded: a dangling parent or a cycle
 * terminates it rather than looping.
 */
export function regenerateBlockedByOtherUser(
  rows: readonly SenderChainRow[],
  tipMessageId: string | null,
  targetMessageId: string,
  userId: string
): boolean {
  if (tipMessageId === null || tipMessageId === targetMessageId) return false;
  const byId = new Map(rows.map((row) => [row.id, row]));
  const visited = new Set<string>();
  let currentId: string | null = tipMessageId;
  while (currentId !== null && currentId !== targetMessageId) {
    if (visited.has(currentId)) break;
    visited.add(currentId);
    const message = byId.get(currentId);
    if (message === undefined) break;
    if (message.senderType === 'user' && message.senderId !== null && message.senderId !== userId) {
      return true;
    }
    currentId = message.parentMessageId;
  }
  return false;
}

function resolveTip(
  stores: ConversationsStores,
  params: CanRegenerateParams
): ResultAsync<string | null, DomainError> {
  if (params.forkId === undefined) {
    return stores.messages.latestId(params.conversationId);
  }
  return stores.forks
    .byId(params.conversationId, params.forkId)
    .map((fork) => fork?.tipMessageId ?? null);
}

/**
 * True when `replaceAssistantId` names an assistant message whose parent is
 * exactly the anchor — the only message a retry-one may delete. A missing id, a
 * user message, or a reply of a different anchor is refused before the paid run.
 */
function isDirectAssistantReply(
  rows: readonly SenderChainRow[],
  replaceAssistantId: string,
  targetMessageId: string
): boolean {
  const row = rows.find((candidate) => candidate.id === replaceAssistantId);
  return row?.senderType === 'assistant' && row.parentMessageId === targetMessageId;
}

/**
 * A no-forkId retry-all/edit deletes every message after the anchor's sequence
 * across the whole conversation; forks share one sequence space, so that delete
 * is safe only on a fork-less conversation. Once forks exist the caller must
 * scope the regenerate to a branch so the branch-aware delete runs instead. A
 * supplied forkId already takes that safe path, so the fork read is skipped.
 */
function forkRequired(
  stores: ConversationsStores,
  params: CanRegenerateParams
): ResultAsync<boolean, DomainError> {
  if (params.forkId !== undefined) return okAsync<boolean, DomainError>(false);
  return stores.forks.list(params.conversationId).map((forks) => forks.length > 0);
}

/**
 * True only when `targetMessageId` is the caller's OWN user message. The
 * regenerate/edit anchor must be the caller's own turn: the settlement deletes
 * the anchor's reply(s) — edit/retry-all delete by sequence from the anchor,
 * retry-one deletes its assistant reply — so anchoring on another member's turn,
 * an assistant message, or a scrubbed (null senderId) message would destroy
 * content the caller does not own. The tip→target walk is exclusive of the
 * target, so a foreign anchor passes every other gate; this is the root check.
 * Fails closed if the target is absent from the chain (readers disagreeing).
 */
function isOwnUserMessage(
  rows: readonly SenderChainRow[],
  targetMessageId: string,
  userId: string
): boolean {
  const row = rows.find((candidate) => candidate.id === targetMessageId);
  return row?.senderType === 'user' && row.senderId === userId;
}

function replaceAndWalkGuard(
  stores: ConversationsStores,
  params: CanRegenerateParams
): ResultAsync<RegenerateDecision, DomainError> {
  return stores.members.listActive(params.conversationId).andThen((members) => {
    const hasOtherMember = members.some((member) => member.userId !== params.userId);
    // The sender chain is read unconditionally: the ownership gate needs it for
    // every regenerate, and it also serves the retry-one replace-target validity
    // and the cross-member walk.
    return stores.messages.senderChainRows(params.conversationId).andThen((rows) => {
      // Ownership gate: the anchor must be the caller's own user message. Without
      // it a member could anchor on another member's turn and the settlement's
      // sequence-scoped delete would destroy that member's content.
      if (!isOwnUserMessage(rows, params.targetMessageId, params.userId)) {
        return okAsync<RegenerateDecision, DomainError>('blocked');
      }
      if (
        params.replaceAssistantId !== undefined &&
        !isDirectAssistantReply(rows, params.replaceAssistantId, params.targetMessageId)
      ) {
        return okAsync<RegenerateDecision, DomainError>('invalid-replace');
      }
      if (!hasOtherMember) return okAsync<RegenerateDecision, DomainError>('allowed');
      return resolveTip(stores, params).map(
        (tip): RegenerateDecision =>
          regenerateBlockedByOtherUser(rows, tip, params.targetMessageId, params.userId)
            ? 'blocked'
            : 'allowed'
      );
    });
  });
}

/**
 * Whether the caller may regenerate/edit from `targetMessageId`. The target must
 * belong to the conversation (`target-missing` → 404); a no-forkId regenerate on
 * a forked conversation is refused (`fork-required`); a retry-one's
 * `replaceAssistantId` must be a direct assistant reply of the anchor
 * (`invalid-replace` → 404); a group regenerate must not delete across another
 * member's message (`blocked` → 403); otherwise `allowed`. Reads only — the
 * regenerate's writes are the settlement's.
 */
export function canRegenerate(
  stores: ConversationsStores,
  params: CanRegenerateParams
): ResultAsync<RegenerateDecision, DomainError> {
  return stores.messages
    .inConversation(params.targetMessageId, params.conversationId)
    .andThen((present): ResultAsync<RegenerateDecision, DomainError> => {
      if (!present) return okAsync<RegenerateDecision, DomainError>('target-missing');
      return forkRequired(stores, params).andThen((required) =>
        required
          ? okAsync<RegenerateDecision, DomainError>('fork-required')
          : replaceAndWalkGuard(stores, params)
      );
    });
}
