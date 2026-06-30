import { eq, gt, and, inArray } from 'drizzle-orm';
import { messages, type DatabaseClient } from '@hushbox/db';

export interface DeleteMessagesAfterAnchorParams {
  conversationId: string;
  anchorMessageId: string;
  forkTipMessageId?: string;
}

export interface DeleteMessagesAfterAnchorResult {
  deletedIds: string[];
}

/**
 * Deletes messages after an anchor point.
 *
 * - No forks path (forkTipMessageId not provided):
 *   Deletes all messages with sequence_number > anchor's sequence_number
 *   in the same conversation.
 *
 * - Fork path (forkTipMessageId provided):
 *   Walks the parent chain from tip to anchor, collects candidates,
 *   checks for shared messages (those with children outside the candidate set),
 *   and deletes only non-shared candidates.
 *
 * Idempotent: re-running after deletion returns empty deletedIds.
 */
export async function deleteMessagesAfterAnchor(
  tx: DatabaseClient,
  params: DeleteMessagesAfterAnchorParams
): Promise<DeleteMessagesAfterAnchorResult> {
  if (params.forkTipMessageId === undefined) {
    return deleteLinear(tx, params.conversationId, params.anchorMessageId);
  }
  return deleteForkChain(
    tx,
    params.conversationId,
    params.anchorMessageId,
    params.forkTipMessageId
  );
}

async function deleteLinear(
  tx: DatabaseClient,
  conversationId: string,
  anchorMessageId: string
): Promise<DeleteMessagesAfterAnchorResult> {
  const [anchor] = await tx
    .select({ sequenceNumber: messages.sequenceNumber })
    .from(messages)
    .where(eq(messages.id, anchorMessageId));

  if (!anchor) {
    return { deletedIds: [] };
  }

  const deleted = await tx
    .delete(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        gt(messages.sequenceNumber, anchor.sequenceNumber)
      )
    )
    .returning({ id: messages.id });

  return { deletedIds: deleted.map((d) => d.id) };
}

/** Walks from tip to anchor, collecting candidate message IDs (excluding anchor). */
function collectCandidates(
  messageMap: Map<string, { id: string; parentMessageId: string | null }>,
  tipId: string,
  anchorId: string
): Set<string> {
  const candidates = new Set<string>();
  let currentId: string | null = tipId;

  while (currentId && currentId !== anchorId) {
    if (candidates.has(currentId)) break; // cycle protection
    candidates.add(currentId);
    const msg = messageMap.get(currentId);
    currentId = msg?.parentMessageId ?? null;
  }

  return candidates;
}

/** Filters candidates to only those without children outside the candidate set. */
function findExclusiveCandidates(
  allMessages: { id: string; parentMessageId: string | null }[],
  candidates: Set<string>
): string[] {
  const childrenMap = new Map<string, string[]>();
  for (const msg of allMessages) {
    if (msg.parentMessageId) {
      const children = childrenMap.get(msg.parentMessageId) ?? [];
      children.push(msg.id);
      childrenMap.set(msg.parentMessageId, children);
    }
  }

  const toDelete: string[] = [];
  for (const candidateId of candidates) {
    const children = childrenMap.get(candidateId) ?? [];
    const hasExternalChild = children.some((childId) => !candidates.has(childId));
    if (!hasExternalChild) {
      toDelete.push(candidateId);
    }
  }

  return toDelete;
}

async function deleteForkChain(
  tx: DatabaseClient,
  conversationId: string,
  anchorMessageId: string,
  forkTipMessageId: string
): Promise<DeleteMessagesAfterAnchorResult> {
  if (forkTipMessageId === anchorMessageId) {
    return { deletedIds: [] };
  }

  const allMessages = await tx
    .select({
      id: messages.id,
      parentMessageId: messages.parentMessageId,
    })
    .from(messages)
    .where(eq(messages.conversationId, conversationId));

  const messageMap = new Map(allMessages.map((m) => [m.id, m]));
  const candidates = collectCandidates(messageMap, forkTipMessageId, anchorMessageId);

  if (candidates.size === 0) {
    return { deletedIds: [] };
  }

  const toDelete = findExclusiveCandidates(allMessages, candidates);

  if (toDelete.length === 0) {
    return { deletedIds: [] };
  }

  await tx.delete(messages).where(inArray(messages.id, toDelete));

  return { deletedIds: toDelete };
}
