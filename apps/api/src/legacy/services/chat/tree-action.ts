import { and, eq } from 'drizzle-orm';
import { ERROR_CODE_FORK_TIP_CONFLICT } from '@hushbox/shared';
import { conversationForks, messages, type DatabaseClient } from '@hushbox/db';
import { deleteMessagesAfterAnchor } from './message-deletion.js';
import { validateParentMessageId, ForkTipConflictError } from './message-helpers.js';

/**
 * How a chat turn grafts onto the message tree. Both `/stream` and
 * `/regenerate` share one persistence path; this prelude is the only step
 * that varies.
 *
 * - `regenerate` covers BOTH wire actions `retry` and `regenerate` — they
 *   are functionally identical on the server.
 */
export type TreeAction =
  | {
      kind: 'fresh-send';
      userMessage: { id: string; content: string };
      parentMessageId: string | null;
    }
  | {
      kind: 'regenerate';
      anchorUserMessageId: string;
      /**
       * Discriminator for retry-all (unset) vs regenerate-one (set):
       *   - unset → every assistant descendant of `anchorUserMessageId` is
       *     deleted; new assistants are created under the anchor.
       *   - set → only this single assistant is deleted; surviving siblings
       *     keep their rows. New assistants inherit the same anchor parent.
       *
       * Multi-model retry-on-failed-tile and per-tile Regenerate buttons
       * both flow through the set branch.
       */
      replaceAssistantId?: string;
      /**
       * When set together with `forkTipMessageId`, the fork row is locked
       * with `SELECT … FOR UPDATE` and the tip is validated up front. After
       * deletion the cascade nulls the tip; this function then returns
       * `forkTipExpectedMessageId: null` so the downstream `updateForkTip`
       * optimistic check matches the cascaded NULL.
       */
      forkId?: string;
      forkTipMessageId?: string;
    }
  | {
      kind: 'edit';
      anchorUserMessageId: string;
      newUserMessage: { id: string; content: string };
      forkId?: string;
      forkTipMessageId?: string;
    };

export interface ApplyTreeActionResult {
  parentMessageIdForAssistants: string;
  /** Undefined for regenerate (existing user msg preserved). */
  userMessageInsert: { id: string; content: string; parentMessageId: string | null } | undefined;
  /** Optimistic-concurrency guard passed to `updateForkTip`. */
  forkTipExpectedMessageId: string | null;
}

/** The user message id this turn is keyed off, regardless of kind. */
export function treeActionUserMessageId(action: TreeAction): string {
  switch (action.kind) {
    case 'fresh-send': {
      return action.userMessage.id;
    }
    case 'regenerate': {
      return action.anchorUserMessageId;
    }
    case 'edit': {
      return action.newUserMessage.id;
    }
  }
}

/**
 * Whether the chat turn's new assistant should become the fork tip.
 *
 * - fresh-send / edit / retry-all → yes (the whole lineage moves forward)
 * - regenerate-one of THE current tip → yes (the cascade nulled the tip; the
 *   replacement becomes the new tip)
 * - regenerate-one of a NON-tip sibling → no (the surviving tip is still the
 *   correct lineage endpoint; the new sibling is alternative content, not a
 *   forward move). Unconditional advancement here used to silently clobber
 *   the tip onto the just-inserted replacement, breaking fork lineage.
 */
export function treeActionShouldAdvanceForkTip(action: TreeAction): boolean {
  if (action.kind !== 'regenerate') return true;
  if (action.replaceAssistantId === undefined) return true;
  return action.replaceAssistantId === action.forkTipMessageId;
}

/**
 * Locks the fork row with `SELECT … FOR UPDATE` and validates that its
 * current tip matches the caller's expectation. Two concurrent regenerate
 * requests targeting the same fork serialize on this row; the second one
 * sees the first's committed tip and surfaces ForkTipConflictError. After
 * this call returns, our transaction owns the row and the
 * `ON DELETE SET NULL` cascade from deleting the tip is safe — no other
 * writer can see the intermediate NULL before our final UPDATE.
 *
 * Threads through `null` as the expected tip, NOT the caller's
 * `forkTipMessageId`: by the time `updateForkTip` runs inside
 * `saveChatTurn`, the FK cascade has already nulled the tip in our
 * transaction's view. The optimistic UPDATE's `WHERE tip_message_id IS NULL`
 * clause matches that cascaded NULL.
 */
async function lockAndValidateForkTip(
  tx: DatabaseClient,
  forkId: string,
  expectedTipMessageId: string | undefined
): Promise<void> {
  const [fork] = await tx
    .select({ tipMessageId: conversationForks.tipMessageId })
    .from(conversationForks)
    .where(eq(conversationForks.id, forkId))
    .for('update');

  if (!fork) return;

  const observed = fork.tipMessageId ?? null;
  const expected = expectedTipMessageId ?? null;
  if (observed !== expected) {
    throw new ForkTipConflictError(ERROR_CODE_FORK_TIP_CONFLICT, forkId, expected);
  }
}

type FreshSendAction = Extract<TreeAction, { kind: 'fresh-send' }>;
type RegenerateActionKind = Extract<TreeAction, { kind: 'regenerate' }>;
type EditAction = Extract<TreeAction, { kind: 'edit' }>;

async function applyFreshSend(
  tx: DatabaseClient,
  conversationId: string,
  action: FreshSendAction
): Promise<ApplyTreeActionResult> {
  await validateParentMessageId(tx, conversationId, action.parentMessageId);
  return {
    parentMessageIdForAssistants: action.userMessage.id,
    userMessageInsert: {
      id: action.userMessage.id,
      content: action.userMessage.content,
      parentMessageId: action.parentMessageId,
    },
    forkTipExpectedMessageId: action.parentMessageId,
  };
}

// forkId path: our delete just cascaded the tip to NULL — that's what
// updateForkTip will see. Non-forkId path keeps legacy behaviour for
// backward compatibility with callers that haven't started passing
// forkId yet.
function expectedTipAfterCascade(action: RegenerateActionKind | EditAction): string | null {
  return action.forkId === undefined ? (action.forkTipMessageId ?? null) : null;
}

// regenerate-one: cascade only nulls the tip when the message we deleted
// WAS the tip. Otherwise the downstream optimistic UPDATE must expect the
// original tip id, not NULL, or it will throw ForkTipConflictError on every
// per-tile regenerate where the tile wasn't the latest in the batch.
function expectedTipAfterPartialReplace(action: RegenerateActionKind): string | null {
  if (action.forkId !== undefined && action.replaceAssistantId === action.forkTipMessageId) {
    return null;
  }
  return action.forkTipMessageId ?? null;
}

async function applyRegenerate(
  tx: DatabaseClient,
  conversationId: string,
  action: RegenerateActionKind
): Promise<ApplyTreeActionResult> {
  if (action.forkId !== undefined) {
    await lockAndValidateForkTip(tx, action.forkId, action.forkTipMessageId);
  }
  if (action.replaceAssistantId !== undefined) {
    await tx
      .delete(messages)
      .where(
        and(eq(messages.id, action.replaceAssistantId), eq(messages.conversationId, conversationId))
      );
    return {
      parentMessageIdForAssistants: action.anchorUserMessageId,
      userMessageInsert: undefined,
      forkTipExpectedMessageId: expectedTipAfterPartialReplace(action),
    };
  }
  await deleteMessagesAfterAnchor(tx, {
    conversationId,
    anchorMessageId: action.anchorUserMessageId,
    ...(action.forkTipMessageId !== undefined && {
      forkTipMessageId: action.forkTipMessageId,
    }),
  });
  return {
    parentMessageIdForAssistants: action.anchorUserMessageId,
    userMessageInsert: undefined,
    forkTipExpectedMessageId: expectedTipAfterCascade(action),
  };
}

async function loadTargetParentId(tx: DatabaseClient, anchorId: string): Promise<string | null> {
  const [target] = await tx
    .select({ parentMessageId: messages.parentMessageId })
    .from(messages)
    .where(eq(messages.id, anchorId));
  if (!target) {
    throw new Error('Target message not found');
  }
  return target.parentMessageId;
}

async function applyEdit(
  tx: DatabaseClient,
  conversationId: string,
  action: EditAction
): Promise<ApplyTreeActionResult> {
  const targetParentId = await loadTargetParentId(tx, action.anchorUserMessageId);
  const forkTipSpread =
    action.forkTipMessageId === undefined ? {} : { forkTipMessageId: action.forkTipMessageId };

  if (action.forkId !== undefined) {
    await lockAndValidateForkTip(tx, action.forkId, action.forkTipMessageId);
  }

  const deletionAnchor = targetParentId ?? action.anchorUserMessageId;
  await deleteMessagesAfterAnchor(tx, {
    conversationId,
    anchorMessageId: deletionAnchor,
    ...forkTipSpread,
  });
  if (targetParentId === null) {
    await tx.delete(messages).where(eq(messages.id, action.anchorUserMessageId));
  }

  return {
    parentMessageIdForAssistants: action.newUserMessage.id,
    userMessageInsert: {
      id: action.newUserMessage.id,
      content: action.newUserMessage.content,
      parentMessageId: targetParentId,
    },
    forkTipExpectedMessageId: expectedTipAfterCascade(action),
  };
}

/**
 * Runs inside the caller's transaction. Throws when an `edit` action
 * references a target id that does not exist — caller's txn rolls back.
 */
export async function applyTreeAction(
  tx: DatabaseClient,
  conversationId: string,
  action: TreeAction
): Promise<ApplyTreeActionResult> {
  switch (action.kind) {
    case 'fresh-send': {
      return applyFreshSend(tx, conversationId, action);
    }
    case 'regenerate': {
      return applyRegenerate(tx, conversationId, action);
    }
    case 'edit': {
      return applyEdit(tx, conversationId, action);
    }
  }
}
