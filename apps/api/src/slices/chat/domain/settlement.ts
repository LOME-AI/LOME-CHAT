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
  const persistable = collectTextCharges(request);
  // Nothing produced → nothing persisted → nothing billed (the interpreter's
  // stopped-with-empty path settles here with no charges).
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

/**
 * Persist the graft: reserve the sequence block, persist the (optional) new
 * user message and the assistant reply, and advance the fork tip. Returns the
 * content-item id minted for each charge key (the charge pairing). Monotonic
 * sequences are never reused, so ordering survives the regenerate delete.
 */
async function writeGraftedTurn(
  ctx: GraftContext,
  params: WriteGraftedTurnParams
): Promise<Map<string, string>> {
  const { deps, conversationsStores, tx } = ctx;
  const { identity } = deps;
  const { graft, epochPublicKey, persistable } = params;
  const contentItemIdByKey = new Map<string, string>();
  const sequences = await reserveSequences(
    conversationsStores,
    identity.conversationId,
    graft.userInsert === undefined ? 1 : 2
  );
  const batchId = deps.newId();
  const { assistantParentId, assistantSequence } = await persistUserMessage(
    ctx,
    graft,
    epochPublicKey,
    { sequences, batchId }
  );

  // The assistant message: reserved sentinel sender, chained onto the graft
  // parent (the new/kept user message), carrying every billable generation.
  const assistantMessageId = deps.newId();
  const assistantContentIds = await persistMessage(tx, deps, {
    messageId: assistantMessageId,
    epochPublicKey,
    senderType: 'assistant',
    senderId: ASSISTANT_SENDER_ID,
    sequenceNumber: assistantSequence,
    parentMessageId: assistantParentId,
    batchId,
    items: persistable.map(({ charge, text }) => ({
      text,
      modelId: charge.modelId,
      providerName: charge.providerName,
      // The charged (post-markup) cost, mirrored for display reads. The markup
      // is a pure function of the base cost; the authoritative charge lands once
      // in `chargeWithinTx` below on the same base.
      cost: applyMarkup(charge.baseCostNanoUsd),
    })),
  });
  for (const [index, { charge }] of persistable.entries()) {
    const contentItemId = assistantContentIds[index];
    /* v8 ignore next -- persistMessage returns one content id per persistable item */
    if (contentItemId === undefined) continue;
    contentItemIdByKey.set(charge.key, contentItemId);
  }

  if (identity.forkId != null && graft.advanceForkTip) {
    await advanceForkTip(conversationsStores, identity.conversationId, identity.forkId, {
      expectedTipMessageId: graft.forkExpectedTip,
      newTipMessageId: assistantMessageId,
    });
  }
  return contentItemIdByKey;
}

/**
 * Persist the new user message (fresh send / edit) and return where the reply
 * chains and which sequence it takes. A retry inserts no user message — it
 * keeps the existing anchor and the reply chains straight onto `assistantParentId`.
 */
async function persistUserMessage(
  ctx: GraftContext,
  graft: GraftPlan,
  epochPublicKey: ReturnType<typeof asEpochPublicKey>,
  block: { readonly sequences: readonly number[]; readonly batchId: string }
): Promise<{ readonly assistantParentId: string | null; readonly assistantSequence: number }> {
  const { deps, tx } = ctx;
  if (graft.userInsert === undefined) {
    const assistantSequence = block.sequences[0];
    /* v8 ignore next 3 -- a one-count reservation always yields its one sequence; guards a would-be reservation invariant break */
    if (assistantSequence === undefined) {
      throw new Error('chat settlement: sequence block did not yield an assistant sequence');
    }
    return { assistantParentId: graft.assistantParentId, assistantSequence };
  }
  const [userSequence, assistantSequence] = block.sequences;
  /* v8 ignore next 3 -- a two-count reservation always yields two sequences; guards a would-be reservation invariant break */
  if (userSequence === undefined || assistantSequence === undefined) {
    throw new Error('chat settlement: sequence block did not yield two sequences');
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
  return { assistantParentId: graft.userInsert.id, assistantSequence };
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

export function createChatSettlementCommit(deps: ChatSettlementDeps): SettlementCommit {
  return async (tx, request) => {
    const contentItemIdByKey = await persistTurnContent(tx, request, deps);
    const charging = createChargingCommit({
      stores: deps.billingStores,
      context: {
        walletId: deps.identity.walletId,
        userId: deps.identity.userId,
        runId: deps.identity.runId,
        now: deps.now(),
        contentItemIdFor: (key) => contentItemIdByKey.get(key),
      },
    });
    await charging(tx, request);
  };
}
