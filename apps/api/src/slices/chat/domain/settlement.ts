import {
  asEpochPublicKey,
  encryptContentEnvelope,
  generateContentKey,
  wrapContentKeyToEpoch,
} from '@hushbox/crypto';
import { createChargingCommit } from '../../workflows/index.js';
import { applyMarkup } from '../../billing/index.js';
import {
  advanceForkTipWithinTx,
  assertWrapEpochWithinTx,
  buildParentIndex,
  createConversationsStores,
  regenerableTailIds,
  reserveSequenceBlockWithinTx,
  resolveForkTipWithinTx,
} from '../../conversations/index.js';
import { conflictError } from '../../../lib/errors/index.js';
import { okAsync } from '../../../lib/result/index.js';
import type { SettlementCommit } from '../../workflows/index.js';
import type { BillingStores } from '../../billing/index.js';
import type { RegenerateAction, SettlementCharge, SettlementRequest } from '@hushbox/shared';
import type { DbWriter, SettlementTx } from '../../../lib/idempotency/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ChatStores } from '../ports/stores.js';

/**
 * The AAD sender bound into the assistant message's content envelopes. A
 * reserved non-user sentinel (the nil UUID), NOT the initiator's userId:
 * `messages.senderId` is scrubbed to null when a user's account is deleted, so
 * binding the initiator would make the assistant's answers undecryptable for
 * co-members after the initiator leaves. The sentinel matches no user, so
 * deletion never touches it; `senderType='assistant'` disambiguates it, and the
 * anti-splice guarantee is unaffected (the per-item AAD still binds messageId,
 * contentItemId, and position).
 */
export const ASSISTANT_SENDER_ID = '00000000-0000-0000-0000-000000000000';

/**
 * The captured send-time epoch was superseded (rotation) or the initiator is no
 * longer a member of it. Thrown from the settlement commit to terminal-fail the
 * run and roll back — nothing persists, so nothing wraps to a stale epoch.
 */
export class EpochWrapConflict extends Error {
  constructor(readonly domainError: DomainError) {
    super('chat settlement: wrap-epoch assertion failed');
    this.name = 'EpochWrapConflict';
  }
}

/**
 * The fork this turn extends was gone at settlement, or its tip moved out from
 * under a settling turn holding the fork-row lock (a concurrency defect).
 * Thrown to terminal-fail the run and roll back — nothing persists, so a stale
 * fork tip never advances onto an unpersisted reply.
 */
export class ForkTipConflict extends Error {
  constructor(readonly domainError: DomainError) {
    super('chat settlement: fork-tip advancement failed');
    this.name = 'ForkTipConflict';
  }
}

/**
 * A tip-deleting regenerate found the fork tip repointed since the pre-run
 * guard validated its deletable tail. Thrown to terminal-fail the run and roll
 * back — nothing deletes, persists, or bills.
 */
export class ForkTipMovedConflict extends Error {
  constructor(readonly domainError: DomainError) {
    super('chat settlement: fork tip moved after the regenerate guard validated its tail');
    this.name = 'ForkTipMovedConflict';
  }
}

/**
 * Every selected model failed: the run reached settlement with no charges (a
 * succeeded generation always produces one). Thrown to terminal-fail the run
 * and roll the settlement back — nothing persists, nothing bills. A multi-model
 * turn tolerates a subset failing; only ALL failing is a terminal failure, and
 * the client is told the turn failed. Consistent with the other settlement
 * conflicts, which the interpreter surfaces as a failed run.
 */
export class EmptyTurnConflict extends Error {
  constructor(readonly domainError: DomainError) {
    super('chat settlement: no model produced content (every selected model failed)');
    this.name = 'EmptyTurnConflict';
  }
}

/**
 * The chat turn's settlement commit: persist the assistant message and its
 * content items, then charge each billable generation — all in the ONE fenced
 * settlement transaction the interpreter enters through the settlement hook.
 * Nothing commits mid-run, so a throw here (a failed persist or charge) unwinds
 * the whole transaction: saved ⟺ billed ⟺ key-row flipped, atomically.
 *
 * Content pairing is keyed by the CHARGE key. Each charge names the generation
 * that produced it (the node id); the interpreter surfaces that generation's
 * content under the same key in `outputs`, so a charge maps to the content item
 * minted for exactly its generation. A charge with no matching persisted
 * content is skipped by the charging commit — no content, no charge.
 */

const textEncoder = new TextEncoder();

/**
 * Reads the epoch public key the assistant output wraps to. Injected by the
 * conversations slice (the single writer of `epochs`); returns null when the
 * conversation's epoch row is absent, which aborts the settlement.
 */
export type EpochPublicKeyReader = (
  tx: DbWriter,
  conversationId: string,
  epochNumber: number
) => Promise<Uint8Array | null>;

/** The run identity the settlement commit closes over (RunContext, sans fence). */
export interface ChatSettlementIdentity {
  readonly conversationId: string;
  readonly epochNumber: number;
  readonly walletId: string;
  readonly userId: string;
  readonly runId: string;
  /**
   * The initiator's message, supplied at send. Its content is persisted as the
   * turn's user message (client-supplied id for idempotent re-execution); the
   * assistant's reply chains onto it.
   */
  readonly userMessage: {
    readonly id: string;
    readonly content: string;
  };
  /**
   * The branch this turn extends. When set, the turn chains onto the fork's tip
   * (resolved under a fork-row lock) instead of the linear high-sequence tip,
   * and advances that tip to the new assistant reply — both inside this
   * settlement transaction. Absent (or null) for a linear send.
   */
  readonly forkId?: string | null;
  /**
   * Present when this turn re-runs an existing turn (regenerate/edit). The
   * settlement deletes the superseded reply(s) below `targetMessageId` and
   * re-parents the new reply — inside this one transaction, BEFORE reserving
   * sequences, so survivors keep the lower sequences. Absent for a fresh send.
   */
  readonly regenerate?: RegenerateAction | null;
}

export interface ChatSettlementDeps {
  readonly identity: ChatSettlementIdentity;
  readonly stores: ChatStores;
  readonly billingStores: BillingStores;
  readonly readEpochPublicKey: EpochPublicKeyReader;
  readonly now: () => Date;
  readonly newId: () => string;
  /**
   * Builds the conversations read/tip stores bound to the settlement
   * transaction. Defaults to the real single-writer factory; injectable so a
   * fault test can drive the parent-chain read-failure arm that rolls the
   * settlement back.
   */
  readonly conversationsStores?: (tx: SettlementTx) => ConversationsStoresHandle;
}

interface PersistableCharge {
  readonly charge: SettlementCharge;
  readonly text: string;
}

/** A billable text generation whose content the run surfaced as an output. */
function collectTextCharges(request: SettlementRequest): PersistableCharge[] {
  const persistable: PersistableCharge[] = [];
  for (const charge of request.charges) {
    const output: (typeof request.outputs)[string] | undefined = request.outputs[charge.key];
    if (output?.kind === 'text') {
      persistable.push({ charge, text: output.text });
    }
  }
  return persistable;
}

async function persistTurnContent(
  tx: SettlementTx,
  request: SettlementRequest,
  deps: ChatSettlementDeps
): Promise<Map<string, string>> {
  // Zero charges is the all-failed signal: a succeeded generation always
  // produces a charge, so no charges means every selected model failed. A
  // multi-model turn tolerates a subset failing (those charges simply never
  // arrive), but ALL failing terminal-fails the run — throw to roll back so
  // nothing persists and nothing bills, and the client is told it failed.
  if (request.charges.length === 0) {
    throw new EmptyTurnConflict(conflictError('chat settlement: no model produced content'));
  }
  const persistable = collectTextCharges(request);
  // Charges arrived but none carry text content (a non-text output in a text
  // turn): persist nothing for them — the charging commit then skips each
  // (no content, no charge).
  if (persistable.length === 0) return new Map<string, string>();

  const { identity } = deps;
  const conversationsStores = deps.conversationsStores
    ? deps.conversationsStores(tx)
    : createConversationsStores(tx);
  const epochPublicKey = await resolveWrapKey(tx, conversationsStores, deps);

  // Resolve the fork's tip under a fork-row lock (serializing against a
  // concurrent `PUT /tip`), held to commit. Both the fresh-send parent and the
  // regenerate delete/advance need it; a linear turn has no fork tip.
  const lockedForkTip =
    identity.forkId == null
      ? null
      : await resolveForkTip(conversationsStores, identity.conversationId, identity.forkId);

  assertObservedForkTip(identity, lockedForkTip);

  // Plan the graft — a fresh send, or a regenerate/edit whose delete prelude
  // runs HERE, before any sequence is reserved, so the new reply always outranks
  // the survivors. `graft` says where the new reply attaches and how the fork
  // tip advances (cascade-aware: deleting the tip nulls it via FK SET NULL).
  const ctx: GraftContext = { tx, conversationsStores, deps, lockedForkTip };
  const graft = await planGraft(ctx);
  return writeGraftedTurn(ctx, { graft, epochPublicKey, persistable });
}

/**
 * The epoch-at-persist gate (forward secrecy): FOR SHARE re-read + assert the
 * send-time epoch is still current and the initiator still belongs to it,
 * INSIDE this transaction, BEFORE wrapping — then read the wrap key. A mismatch
 * or a missing epoch throws, rolling the whole settlement back so content never
 * wraps to a superseded epoch.
 */
async function resolveWrapKey(
  tx: SettlementTx,
  conversationsStores: ConversationsStoresHandle,
  deps: ChatSettlementDeps
): Promise<ReturnType<typeof asEpochPublicKey>> {
  const { identity } = deps;
  const epochCheck = await assertWrapEpochWithinTx(conversationsStores, {
    conversationId: identity.conversationId,
    epochNumber: identity.epochNumber,
    userId: identity.userId,
  });
  if (epochCheck.isErr()) throw new EpochWrapConflict(epochCheck.error);
  const rawKey = await deps.readEpochPublicKey(tx, identity.conversationId, identity.epochNumber);
  if (rawKey === null) {
    throw new Error(
      `chat settlement: conversation ${identity.conversationId} has no epoch ${String(identity.epochNumber)} to wrap to`
    );
  }
  return asEpochPublicKey(rawKey);
}

type ConversationsStoresHandle = ReturnType<typeof createConversationsStores>;

/** The collaborators every graft step closes over — bundled to stay under the param cap. */
interface GraftContext {
  readonly tx: SettlementTx;
  readonly conversationsStores: ConversationsStoresHandle;
  readonly deps: ChatSettlementDeps;
  readonly lockedForkTip: string | null;
}

/**
 * Where the new reply grafts onto the tree, and how the fork tip advances.
 * `userInsert` is present for a fresh send / edit (a new user message is
 * persisted, the reply chains onto it) and absent for a retry (the existing
 * anchor user message is kept, the reply chains onto `assistantParentId`).
 * `forkExpectedTip` is the fork-tip CAS's expected value — cascade-aware:
 * `null` when the delete removed the tip (the FK `ON DELETE SET NULL` nulled
 * it), else the locked tip.
 */
interface GraftPlan {
  readonly userInsert?: {
    readonly id: string;
    readonly content: string;
    readonly parentMessageId: string | null;
  };
  readonly assistantParentId: string | null;
  readonly advanceForkTip: boolean;
  readonly forkExpectedTip: string | null;
}

interface WriteGraftedTurnParams {
  readonly graft: GraftPlan;
  readonly epochPublicKey: ReturnType<typeof asEpochPublicKey>;
  readonly persistable: readonly PersistableCharge[];
}

/** One assistant message's worth of content: the charges of a single originating node. */
interface AssistantGroup {
  readonly key: string;
  readonly items: readonly PersistableCharge[];
}

/**
 * Groups billable content by the ORIGINATING generation (the charge key = the
 * producing node id). Each group becomes one assistant sibling message — N
 * multi-model nodes → N sibling messages.
 * A single-model turn's one charge is one group, so it persists as one message.
 * Insertion order is preserved (the interpreter surfaces charges in node order,
 * which is the selected-model order), so the last group is the last sibling.
 */
function groupByOriginatingNode(persistable: readonly PersistableCharge[]): AssistantGroup[] {
  const order: string[] = [];
  const byKey = new Map<string, PersistableCharge[]>();
  for (const item of persistable) {
    const existing = byKey.get(item.charge.key);
    if (existing === undefined) {
      order.push(item.charge.key);
      byKey.set(item.charge.key, [item]);
    } else {
      existing.push(item);
    }
  }
  return order.map((key) => ({ key, items: byKey.get(key) ?? [] }));
}

/**
 * Persist the graft: reserve the sequence block, persist the (optional) new
 * user message, then one assistant sibling message per originating model node,
 * and advance the fork tip to the LAST sibling. All siblings share the turn's
 * batch id and chain onto the same parent (the new/kept user message). Returns
 * the content-item id minted for each charge key (the charge pairing).
 * Monotonic sequences are never reused, so ordering survives the regenerate
 * delete.
 */
async function writeGraftedTurn(
  ctx: GraftContext,
  params: WriteGraftedTurnParams
): Promise<Map<string, string>> {
  const { deps, conversationsStores } = ctx;
  const { identity } = deps;
  const { graft, epochPublicKey, persistable } = params;
  const groups = groupByOriginatingNode(persistable);
  const userMsgCount = graft.userInsert === undefined ? 0 : 1;
  const sequences = await reserveSequences(
    conversationsStores,
    identity.conversationId,
    userMsgCount + groups.length
  );
  const batchId = deps.newId();
  const assistantParentId = await persistUserMessage(ctx, graft, epochPublicKey, {
    sequences,
    batchId,
  });

  const contentItemIdByKey = new Map<string, string>();
  let lastSiblingId: string | undefined;
  for (const [index, group] of groups.entries()) {
    const assistantSequence = sequences[userMsgCount + index];
    /* v8 ignore next 3 -- the reservation is sized to userMsgCount + groups.length, so each group has its sequence; guards a would-be reservation invariant break */
    if (assistantSequence === undefined) {
      throw new Error('chat settlement: sequence block did not yield an assistant sequence');
    }
    lastSiblingId = await persistAssistantSibling(ctx, {
      group,
      epochPublicKey,
      sequenceNumber: assistantSequence,
      parentMessageId: assistantParentId,
      batchId,
      contentItemIdByKey,
    });
  }

  // The all-failed case throws before this function, so at least one group
  // persisted and lastSiblingId is set.
  /* v8 ignore next 3 -- groups is non-empty (empty charges terminal-fail upstream), so the loop always sets lastSiblingId */
  if (lastSiblingId === undefined) {
    throw new Error('chat settlement: no assistant sibling was persisted');
  }
  if (identity.forkId != null && graft.advanceForkTip) {
    await advanceForkTip(conversationsStores, identity.conversationId, identity.forkId, {
      expectedTipMessageId: graft.forkExpectedTip,
      newTipMessageId: lastSiblingId,
    });
  }
  return contentItemIdByKey;
}

interface PersistSiblingParams {
  readonly group: AssistantGroup;
  readonly epochPublicKey: ReturnType<typeof asEpochPublicKey>;
  readonly sequenceNumber: number;
  readonly parentMessageId: string | null;
  readonly batchId: string;
  readonly contentItemIdByKey: Map<string, string>;
}

/**
 * Persist one assistant sibling message — reserved sentinel sender, chained onto
 * the shared parent (the new/kept user message), carrying its originating node's
 * generation(s) as content items — and record each generation's content-item id
 * against its charge key (the charge pairing). Returns the message id.
 */
async function persistAssistantSibling(
  ctx: GraftContext,
  params: PersistSiblingParams
): Promise<string> {
  const { deps, tx } = ctx;
  const assistantMessageId = deps.newId();
  const contentIds = await persistMessage(tx, deps, {
    messageId: assistantMessageId,
    epochPublicKey: params.epochPublicKey,
    senderType: 'assistant',
    senderId: ASSISTANT_SENDER_ID,
    sequenceNumber: params.sequenceNumber,
    parentMessageId: params.parentMessageId,
    batchId: params.batchId,
    items: params.group.items.map(({ charge, text }) => ({
      text,
      modelId: charge.modelId,
      providerName: charge.providerName,
      // The charged (post-markup) cost, mirrored for display reads. The markup
      // is a pure function of the base cost; the authoritative charge lands once
      // in `chargeWithinTx` on the same base.
      cost: applyMarkup(charge.baseCostNanoUsd),
    })),
  });
  for (const [index, { charge }] of params.group.items.entries()) {
    const contentItemId = contentIds[index];
    /* v8 ignore next -- persistMessage returns one content id per persistable item */
    if (contentItemId === undefined) continue;
    params.contentItemIdByKey.set(charge.key, contentItemId);
  }
  return assistantMessageId;
}

/**
 * Persist the new user message (fresh send / edit) at the first reserved
 * sequence and return the parent the assistant siblings chain onto. A retry
 * inserts no user message — it keeps the existing anchor, and the siblings chain
 * straight onto `graft.assistantParentId`.
 */
async function persistUserMessage(
  ctx: GraftContext,
  graft: GraftPlan,
  epochPublicKey: ReturnType<typeof asEpochPublicKey>,
  block: { readonly sequences: readonly number[]; readonly batchId: string }
): Promise<string | null> {
  const { deps, tx } = ctx;
  if (graft.userInsert === undefined) {
    return graft.assistantParentId;
  }
  const userSequence = block.sequences[0];
  /* v8 ignore next 3 -- a reservation of userMsgCount + groups.length always yields the user sequence at index 0; guards a would-be reservation invariant break */
  if (userSequence === undefined) {
    throw new Error('chat settlement: sequence block did not yield a user sequence');
  }
  await persistMessage(tx, deps, {
    messageId: graft.userInsert.id,
    epochPublicKey,
    senderType: 'user',
    senderId: deps.identity.userId,
    sequenceNumber: userSequence,
    parentMessageId: graft.userInsert.parentMessageId,
    batchId: block.batchId,
    items: [{ text: graft.userInsert.content, modelId: null, providerName: null, cost: null }],
  });
  return graft.userInsert.id;
}

/** Reserve `count` monotonic sequences; a missing conversation is unreachable past the epoch gate. */
async function reserveSequences(
  conversationsStores: ConversationsStoresHandle,
  conversationId: string,
  count: number
): Promise<readonly number[]> {
  const block = await reserveSequenceBlockWithinTx(conversationsStores, { conversationId, count });
  return block.match(
    (sequences) => sequences,
    /* v8 ignore next 3 -- the epoch gate above already asserted the conversation exists, so the reservation cannot report it missing here */
    (error) => {
      throw new Error('chat settlement: sequence block reservation failed', { cause: error });
    }
  );
}

/**
 * A regenerate whose deletable tail is computed from the fork tip: retry-all
 * (no `replaceAssistantId`) and edit both derive their delete set from the
 * live tip via `computeForkTail`. Retry-one deletes a fixed, guard-validated
 * `replaceAssistantId`, not a tip-derived tail, so it is immune to a moved tip.
 */
function deletesForkTailByTip(regenerate: RegenerateAction): boolean {
  return regenerate.action === 'edit' || regenerate.replaceAssistantId === undefined;
}

/**
 * The fork-tip TOCTOU fence. The pre-run guard's cross-member walk validated
 * the deletable tail against the fork tip it observed at route time. But the
 * fork tip is mutable by a separate `PUT /tip` route mid-run (one-run-per-
 * conversation gates only run starts, not tip edits), so a co-member's branch
 * can be spliced onto the tip after the guard passed. Deleting from the live
 * tip without re-checking it would let the settlement sweep content the guard
 * never validated. So for a tip-deleting regenerate on a fork, assert the tip
 * the fork-row lock resolved still equals the guard-observed tip (null-safe:
 * both-null passes, null-vs-value fails) BEFORE any tail is computed; a
 * mismatch throws, rolling the whole settlement back.
 */
function assertObservedForkTip(
  identity: ChatSettlementIdentity,
  lockedForkTip: string | null
): void {
  const regenerate = identity.regenerate ?? null;
  if (identity.forkId == null || regenerate === null) return;
  if (!deletesForkTailByTip(regenerate)) return;
  const observed = regenerate.observedForkTipId ?? null;
  if (lockedForkTip !== observed) {
    throw new ForkTipMovedConflict(
      conflictError('chat settlement: fork tip moved before the regenerate could settle')
    );
  }
}

/** Dispatches the graft on the run's tree action: fresh send, retry, or edit. */
async function planGraft(ctx: GraftContext): Promise<GraftPlan> {
  const regenerate = ctx.deps.identity.regenerate ?? null;
  if (regenerate === null) return planFreshSend(ctx);
  if (regenerate.action === 'edit') return planEdit(ctx, regenerate);
  return planRetry(ctx, regenerate);
}

/** Fresh send: chain the new user message onto the tip and advance to the reply. */
async function planFreshSend(ctx: GraftContext): Promise<GraftPlan> {
  const { deps, tx, lockedForkTip } = ctx;
  const { identity } = deps;
  const parent =
    identity.forkId == null
      ? await deps.stores.latestMessageIdWithinTx(tx, identity.conversationId)
      : lockedForkTip;
  return {
    userInsert: {
      id: identity.userMessage.id,
      content: identity.userMessage.content,
      parentMessageId: parent,
    },
    assistantParentId: null,
    advanceForkTip: true,
    forkExpectedTip: parent,
  };
}

/**
 * Retry: keep the anchor user message; the reply re-parents onto it. Retry-one
 * (`replaceAssistantId` set) deletes just that reply and advances the fork tip
 * only when the replaced reply WAS the tip. Retry-all deletes every reply below
 * the anchor (linear: by sequence; fork: the exclusive tail).
 */
async function planRetry(ctx: GraftContext, regenerate: RegenerateAction): Promise<GraftPlan> {
  const { deps, tx, lockedForkTip } = ctx;
  const { identity } = deps;
  const anchorId = regenerate.targetMessageId;
  if (regenerate.replaceAssistantId !== undefined) {
    await deps.stores.deleteMessagesByIdWithinTx(tx, identity.conversationId, [
      regenerate.replaceAssistantId,
    ]);
    return {
      assistantParentId: anchorId,
      advanceForkTip: identity.forkId != null && regenerate.replaceAssistantId === lockedForkTip,
      forkExpectedTip: null,
    };
  }
  const deletedTip = await deleteBelowAnchor(ctx, anchorId);
  return {
    assistantParentId: anchorId,
    advanceForkTip: identity.forkId != null,
    forkExpectedTip: deletedTip ? null : lockedForkTip,
  };
}

/**
 * Edit: delete from the anchor's PARENT down (the old user message and its
 * replies), then insert the new user message re-parented to that parent. A root
 * anchor (no parent) is deleted explicitly after its subtree.
 */
async function planEdit(ctx: GraftContext, regenerate: RegenerateAction): Promise<GraftPlan> {
  const { deps, lockedForkTip } = ctx;
  const { identity } = deps;
  const anchorId = regenerate.targetMessageId;
  const anchorRef = await deps.stores.messageRefWithinTx(ctx.tx, identity.conversationId, anchorId);
  if (anchorRef === null) {
    throw new Error('chat settlement: regenerate edit target message not found');
  }
  const targetParentId = anchorRef.parentMessageId;
  const deletedTip = await deleteForEdit(ctx, { anchorId, anchorRef, targetParentId });
  return {
    userInsert: {
      id: identity.userMessage.id,
      content: identity.userMessage.content,
      parentMessageId: targetParentId,
    },
    assistantParentId: null,
    advanceForkTip: identity.forkId != null,
    forkExpectedTip: deletedTip ? null : lockedForkTip,
  };
}

/**
 * The edit delete: everything from the anchor's parent down, then the root
 * anchor itself when it had no parent. Returns whether the locked fork tip was
 * among the deleted ids (always false on a linear turn — no fork tip).
 */
async function deleteForEdit(
  ctx: GraftContext,
  target: {
    readonly anchorId: string;
    readonly anchorRef: { readonly sequenceNumber: number };
    readonly targetParentId: string | null;
  }
): Promise<boolean> {
  const { deps, tx, lockedForkTip } = ctx;
  const { identity } = deps;
  const { anchorId, anchorRef, targetParentId } = target;
  const deletionAnchorId = targetParentId ?? anchorId;
  if (identity.forkId == null) {
    const deletionRef =
      deletionAnchorId === anchorId
        ? anchorRef
        : await deps.stores.messageRefWithinTx(tx, identity.conversationId, deletionAnchorId);
    /* v8 ignore next 3 -- deletionRef is the anchor (non-null) or the anchor's still-present parent (an existing parentMessageId); a null here is an unreachable concurrent delete within one transaction */
    if (deletionRef === null) {
      throw new Error('chat settlement: regenerate edit deletion anchor not found');
    }
    await deps.stores.deleteAfterSequenceWithinTx(
      tx,
      identity.conversationId,
      deletionRef.sequenceNumber
    );
    if (targetParentId === null) {
      await deps.stores.deleteMessagesByIdWithinTx(tx, identity.conversationId, [anchorId]);
    }
    return false;
  }
  const tail = await computeForkTail(ctx, deletionAnchorId);
  const idsToDelete = targetParentId === null ? [...tail, anchorId] : tail;
  await deps.stores.deleteMessagesByIdWithinTx(tx, identity.conversationId, idsToDelete);
  return lockedForkTip !== null && idsToDelete.includes(lockedForkTip);
}

/**
 * Delete every reply below the anchor for a retry-all. Linear: by sequence
 * (returns false — a linear turn has no fork tip). Fork: the exclusive tail
 * (returns whether that tail included the locked tip, so the caller can make
 * the fork-tip CAS cascade-aware).
 */
async function deleteBelowAnchor(ctx: GraftContext, anchorId: string): Promise<boolean> {
  const { deps, tx, lockedForkTip } = ctx;
  const { identity } = deps;
  if (identity.forkId == null) {
    const anchorRef = await deps.stores.messageRefWithinTx(tx, identity.conversationId, anchorId);
    if (anchorRef !== null) {
      await deps.stores.deleteAfterSequenceWithinTx(
        tx,
        identity.conversationId,
        anchorRef.sequenceNumber
      );
    }
    return false;
  }
  const tail = await computeForkTail(ctx, anchorId);
  await deps.stores.deleteMessagesByIdWithinTx(tx, identity.conversationId, tail);
  return lockedForkTip !== null && tail.includes(lockedForkTip);
}

/** The fork's exclusive deletable tail from its tip up to (exclusive of) the anchor. */
async function computeForkTail(ctx: GraftContext, anchorId: string): Promise<string[]> {
  const rows = await ctx.conversationsStores.messages
    .parentChainRows(ctx.deps.identity.conversationId)
    .match(
      (chainRows) => chainRows,
      (error) => {
        throw new Error('chat settlement: parent-chain read failed', { cause: error });
      }
    );
  return regenerableTailIds(buildParentIndex(rows), ctx.lockedForkTip, anchorId);
}

/**
 * Resolves a fork's tip under a fork-row `FOR UPDATE` lock (held to commit).
 * A fork absent at settlement — deleted while the run executed — throws to
 * terminal-fail the run so nothing persists against a stale branch.
 */
async function resolveForkTip(
  conversationsStores: ReturnType<typeof createConversationsStores>,
  conversationId: string,
  forkId: string
): Promise<string | null> {
  const resolved = await resolveForkTipWithinTx(conversationsStores, { conversationId, forkId });
  if (resolved.isErr()) throw new ForkTipConflict(resolved.error);
  return resolved.value.tipMessageId;
}

/**
 * Advances a fresh-send fork's tip: CAS it from the prior tip (the parent the
 * messages chained onto) to the new assistant reply, through the same
 * IS-NOT-DISTINCT-FROM CAS the `PUT /tip` route uses. Under the fork-row lock
 * the resolve step took, the CAS always holds; a zero-row outcome throws and
 * rolls the whole settlement back.
 */
async function advanceForkTip(
  conversationsStores: ReturnType<typeof createConversationsStores>,
  conversationId: string,
  forkId: string,
  tips: { readonly expectedTipMessageId: string | null; readonly newTipMessageId: string }
): Promise<void> {
  const advanced = await advanceForkTipWithinTx(conversationsStores, {
    conversationId,
    forkId,
    ...tips,
  });
  /* v8 ignore next -- the fork-row lock the resolve step holds guarantees the CAS matches its own locked tip; a zero-row outcome is an unreachable concurrency defect, guarded defensively */
  if (advanced.isErr()) throw new ForkTipConflict(advanced.error);
}

interface PersistItem {
  readonly text: string;
  readonly modelId: string | null;
  readonly providerName: string | null;
  readonly cost: bigint | null;
}

interface PersistMessageParams {
  readonly messageId: string;
  readonly epochPublicKey: ReturnType<typeof asEpochPublicKey>;
  readonly senderType: 'user' | 'assistant';
  readonly senderId: string;
  readonly sequenceNumber: number;
  readonly parentMessageId: string | null;
  readonly batchId: string;
  readonly items: readonly PersistItem[];
}

/**
 * Persist one message and its content items under a fresh, wrap-once content
 * key (each message is independently decryptable). The per-item AAD binds the
 * full location tuple and the message's sender, so ciphertext cannot be spliced
 * between messages. Returns the minted content-item ids in item order.
 */
async function persistMessage(
  tx: SettlementTx,
  deps: ChatSettlementDeps,
  params: PersistMessageParams
): Promise<string[]> {
  const contentKey = generateContentKey();
  const wrappedContentKey = wrapContentKeyToEpoch(params.epochPublicKey, contentKey);
  await deps.stores.insertMessageWithinTx(tx, {
    id: params.messageId,
    conversationId: deps.identity.conversationId,
    senderType: params.senderType,
    senderId: params.senderId,
    wrappedContentKey,
    epochNumber: deps.identity.epochNumber,
    sequenceNumber: params.sequenceNumber,
    parentMessageId: params.parentMessageId,
    batchId: params.batchId,
  });

  const contentItemIds: string[] = [];
  let position = 0;
  for (const item of params.items) {
    const contentItemId = deps.newId();
    const encryptedBlob = encryptContentEnvelope(
      contentKey,
      wrappedContentKey,
      {
        conversationId: deps.identity.conversationId,
        messageId: params.messageId,
        contentItemId,
        position,
        epochNumber: deps.identity.epochNumber,
        senderId: params.senderId,
      },
      textEncoder.encode(item.text)
    );
    await deps.stores.insertContentItemWithinTx(tx, {
      id: contentItemId,
      messageId: params.messageId,
      position,
      encryptedBlob,
      modelId: item.modelId,
      providerName: item.providerName,
      costNanoUsd: item.cost,
    });
    contentItemIds.push(contentItemId);
    position += 1;
  }
  return contentItemIds;
}

/** The initiator's member-budget attribution for a group turn; `null` = unlimited. */
interface MemberBudgetAttribution {
  readonly memberId: string;
  readonly budgetNanoUsd: bigint;
}

/**
 * Resolves the initiator's group member-budget attribution INSIDE the settlement
 * transaction, so the member-spend write commits atomically with the content and
 * charges. Read/write consistency with the admission gate is by construction: the
 * conversation's configured budget is snapshotted as the member period row's cap,
 * and the member is resolved with the SAME `activeByUser(conversationId, userId)`
 * the admission read uses. A `0` budget (the schema default — none configured)
 * yields no attribution, so no member row is written and admission finds none,
 * treating the member as unlimited. The epoch-at-persist gate ran first (in
 * `persistTurnContent`), so the conversation exists and the initiator is an active
 * member here — the null guards are unreachable defensive checks. An infra read
 * failure throws, rolling the whole settlement back.
 */
function resolveMemberBudgetAttribution(
  tx: SettlementTx,
  deps: ChatSettlementDeps
): Promise<MemberBudgetAttribution | null> {
  const conversationsStores = deps.conversationsStores
    ? deps.conversationsStores(tx)
    : createConversationsStores(tx);
  const { conversationId, userId } = deps.identity;
  return conversationsStores.conversations
    .get(conversationId)
    .andThen((conversation) => {
      /* v8 ignore next 3 -- the epoch-at-persist gate asserted the conversation exists before this runs; a null here is unreachable */
      if (conversation === null) {
        return okAsync<MemberBudgetAttribution | null, DomainError>(null);
      }
      const budgetNanoUsd = conversation.budgetNanoUsd;
      if (budgetNanoUsd <= 0n) {
        return okAsync<MemberBudgetAttribution | null, DomainError>(null);
      }
      return conversationsStores.members.activeByUser(conversationId, userId).map((member) => {
        /* v8 ignore next -- the epoch gate asserted active membership; a null member here is unreachable */
        if (member === null) return null;
        return { memberId: member.id, budgetNanoUsd };
      });
    })
    .match(
      (attribution) => attribution,
      (error) => {
        throw new Error('chat settlement: member-budget read failed', { cause: error });
      }
    );
}

export function createChatSettlementCommit(deps: ChatSettlementDeps): SettlementCommit {
  return async (tx, request) => {
    const contentItemIdByKey = await persistTurnContent(tx, request, deps);
    const memberBudget = await resolveMemberBudgetAttribution(tx, deps);
    const charging = createChargingCommit({
      stores: deps.billingStores,
      context: {
        walletId: deps.identity.walletId,
        userId: deps.identity.userId,
        runId: deps.identity.runId,
        now: deps.now(),
        contentItemIdFor: (key) => contentItemIdByKey.get(key),
        ...(memberBudget === null ? {} : { memberBudget }),
      },
    });
    await charging(tx, request);
  };
}
