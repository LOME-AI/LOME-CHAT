import { useMemo } from 'react';
import type { Message } from '@/lib/api.js';

interface Fork {
  id: string;
  name: string;
  tipMessageId: string | null;
  createdAt: string;
}

type MessageWithParent = Message & { parentMessageId?: string | null };

/** Walk tip → root via parentMessageId, collecting ancestor IDs. */
function collectAncestorIds(
  tipMessage: MessageWithParent,
  messageMap: Map<string, MessageWithParent>
): Set<string> {
  const ancestorIds = new Set<string>();
  const visited = new Set<string>();
  let current: MessageWithParent | undefined = tipMessage;

  while (current) {
    if (visited.has(current.id)) break;
    visited.add(current.id);
    ancestorIds.add(current.id);
    const parentId: string | null | undefined = current.parentMessageId;
    current = parentId ? messageMap.get(parentId) : undefined;
  }

  return ancestorIds;
}

/**
 * Two assistant messages with the same parentMessageId are multi-model peers
 * iff they were persisted in the same `saveChatTurn` — i.e. their `batchId`s
 * match. This distinguishes:
 *
 *   - **Multi-model fan-out** (same batch): u1 → [a1, a2] from one user send;
 *     a1 and a2 are peers and must both appear on every branch that includes
 *     u1, even if a later fork branches beneath one of them.
 *   - **Fork-preserve orphan** (different batches): retry of u1 upstream of a
 *     fork can't delete the prior assistant a1 because the fork's tail still
 *     points at it, so a1 (batch_T0) and the new a1_new (batch_T_new) end up
 *     as siblings under u1 — but a1 belongs to the fork's branch, not Main.
 *
 * The fallback to `false` when either side lacks a batchId is intentional:
 * legacy rows pre-migration share `batch_id = gen_random_uuid()` defaults
 * which never collide, so they'll fail this comparison and fall through to
 * the containment check — same behavior as if the field had been there all
 * along. The streaming/optimistic path on the client constructs messages
 * before the API responds and may also have undefined batchIds; in that
 * window the user only sees their own branch, so peer-recognition isn't
 * needed yet.
 */
function isParallelBatchSibling(sibling: MessageWithParent, ancestor: MessageWithParent): boolean {
  /* v8 ignore next -- siblingsToInclude only calls this for siblings already known to be assistants, so the non-assistant arm is unreachable */
  if (sibling.role !== 'assistant') return false;
  if (sibling.batchId === undefined || ancestor.batchId === undefined) return false;
  return sibling.batchId === ancestor.batchId;
}

/**
 * Non-assistant siblings (user messages sharing a parentMessageId under an
 * assistant ancestor) represent divergent conversation threads — typically
 * the first message of a different fork. They're only safe to render on
 * this branch when their entire subtree is already in our ancestor chain;
 * otherwise the subtree belongs to a different fork and rendering the
 * sibling here would surface that fork's content.
 */
function isContainedThreadSibling(
  sibling: MessageWithParent,
  ancestorIds: Set<string>,
  childrenMap: Map<string | null, MessageWithParent[]>
): boolean {
  const children = childrenMap.get(sibling.id) ?? [];
  return children.every((c) => ancestorIds.has(c.id));
}

/**
 * Returns siblings of `ancestorId` that should be included on this branch.
 *
 * Assistants and non-assistants use different rules and do NOT fall back to
 * each other. An assistant sibling either matches the ancestor's batchId
 * (multi-model peer) or is excluded — running the containment check on an
 * assistant would let any leaf assistant from a different branch sneak in
 * (vacuously "all children in chain"). User-shaped siblings still go
 * through containment to keep the original cross-fork user-thread guard.
 *
 * Caller is responsible for deduping; this returns every candidate that
 * passes the role-shaped predicate.
 */
function siblingsToInclude(
  ancestorId: string,
  ancestorIds: Set<string>,
  messageMap: Map<string, MessageWithParent>,
  childrenMap: Map<string | null, MessageWithParent[]>
): MessageWithParent[] {
  const msg = messageMap.get(ancestorId);
  /* v8 ignore next -- ancestorId always comes from the ancestor set collected out of messageMap, so the message is always present */
  if (!msg) return [];
  const parentId = msg.parentMessageId;
  if (parentId === undefined) return [];
  const siblings = childrenMap.get(parentId ?? null) ?? [];
  return siblings.filter((sibling) => {
    if (sibling.id === ancestorId) return false;
    if (sibling.role === 'assistant') return isParallelBatchSibling(sibling, msg);
    return isContainedThreadSibling(sibling, ancestorIds, childrenMap);
  });
}

/**
 * Expand ancestor set to include siblings. Two distinct rules apply:
 *
 * - Parallel-batch siblings: included when the sibling shares its parent's
 *   `batchId` AND has role `assistant`. This catches multi-model fan-out
 *   without misclassifying a fork-preserve orphan (an old assistant left
 *   under the same user message because a fork branch still references it).
 * - Containment-based siblings (everything else, including assistants that
 *   failed the batch-id check): included only if their subtree is fully
 *   inside the ancestor chain. Prevents leaking a different fork's tail
 *   onto this branch.
 */
function expandWithSiblings(
  ancestorIds: Set<string>,
  messageMap: Map<string, MessageWithParent>,
  childrenMap: Map<string | null, MessageWithParent[]>
): Set<string> {
  const included = new Set<string>(ancestorIds);
  for (const id of ancestorIds) {
    for (const sibling of siblingsToInclude(id, ancestorIds, messageMap, childrenMap)) {
      included.add(sibling.id);
    }
  }
  return included;
}

/**
 * Walk from the tip message to the root via parentMessageId, then expand each
 * chain node to include sibling messages (multi-model responses that share the
 * same parentMessageId). Returns messages sorted by their original array order.
 */
function walkParentChainWithSiblings(
  tipMessage: MessageWithParent,
  messageMap: Map<string, MessageWithParent>,
  childrenMap: Map<string | null, MessageWithParent[]>,
  allMessages: MessageWithParent[]
): MessageWithParent[] {
  const ancestorIds = collectAncestorIds(tipMessage, messageMap);
  const included = expandWithSiblings(ancestorIds, messageMap, childrenMap);
  return allMessages.filter((m) => included.has(m.id));
}

/**
 * Filters messages for the active fork by walking the parent chain from the fork's tip.
 *
 * - No forks → return messages sorted by creation order (sequenceNumber proxy via array index)
 * - With forks → build chain from tip to root, expand to include sibling messages
 *   (multi-model responses sharing the same parentMessageId), preserve original order
 *
 * Pure function extracted for testing.
 */
/** Build parentId → children[] lookup map. */
function buildChildrenMap(messages: MessageWithParent[]): Map<string | null, MessageWithParent[]> {
  const childrenMap = new Map<string | null, MessageWithParent[]>();
  for (const msg of messages) {
    const pid = msg.parentMessageId ?? null;
    const array = childrenMap.get(pid);
    if (array) {
      array.push(msg);
    } else {
      childrenMap.set(pid, [msg]);
    }
  }
  return childrenMap;
}

/**
 * Resolves the active fork's tip message, or returns null if the request
 * should fall through to "return all messages" (no active fork, fork not
 * found, or tip references a missing message id).
 */
function resolveActiveTipMessage(
  forks: Fork[],
  activeForkId: string | null,
  messageMap: Map<string, MessageWithParent>
): MessageWithParent | null {
  if (forks.length === 0 || activeForkId === null) return null;
  const activeFork = forks.find((f) => f.id === activeForkId);
  if (!activeFork?.tipMessageId) return null;
  return messageMap.get(activeFork.tipMessageId) ?? null;
}

export function filterMessagesForFork(
  allMessages: MessageWithParent[],
  forks: Fork[],
  activeForkId: string | null
): MessageWithParent[] {
  if (allMessages.length === 0) return [];

  const messageMap = new Map<string, MessageWithParent>();
  for (const msg of allMessages) {
    messageMap.set(msg.id, msg);
  }

  const tipMessage = resolveActiveTipMessage(forks, activeForkId, messageMap);
  if (!tipMessage) return [...allMessages];

  const childrenMap = buildChildrenMap(allMessages);
  return walkParentChainWithSiblings(tipMessage, messageMap, childrenMap, allMessages);
}

/**
 * React hook that memoizes fork-filtered messages.
 *
 * - No forks → returns messages as-is (sorted by sequenceNumber)
 * - With forks → builds chain from tip to root for the active fork, includes siblings
 */
export function useForkMessages(
  allMessages: MessageWithParent[],
  forks: Fork[],
  activeForkId: string | null
): MessageWithParent[] {
  return useMemo(
    () => filterMessagesForFork(allMessages, forks, activeForkId),
    [allMessages, forks, activeForkId]
  );
}
