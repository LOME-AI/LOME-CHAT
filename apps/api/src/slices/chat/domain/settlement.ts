import { asEpochPublicKey } from '@hushbox/crypto';
import { ERROR_CODES, toBase64 } from '@hushbox/shared';
import {
  AllBranchesFailedError,
  SettlementConflictError,
  anchorChargeKey,
  createChargingCommit,
} from '../../workflows/index.js';
import {
  MEDIA_STORAGE_COST_PER_BYTE_NANO,
  STORAGE_COST_PER_CHARACTER_NANO,
} from '../../billing/index.js';
import {
  advanceForkTipWithinTx,
  assertWrapEpochByMemberWithinTx,
  buildParentIndex,
  createConversationsStores,
  regenerableTailIds,
  reserveSequenceBlockWithinTx,
  resolveCallerMember,
  resolveCallerPublicKey,
  resolveForkTipWithinTx,
} from '../../conversations/index.js';
import { conflictError, forbiddenError } from '../../../lib/errors/index.js';
import { okAsync } from '../../../lib/result/index.js';
import { persistEncryptedMessage } from './message-write.js';
import { senderCaller, senderPrincipalId } from './sender.js';
import type { SettlementCommit } from '../../workflows/index.js';
import type { BillingStores, ChargeSender } from '../../billing/index.js';
import type { ConversationCaller } from '../../conversations/index.js';
import type {
  ErrorCode,
  MediaPersistPlan,
  MediaValue,
  Modality,
  RegenerateAction,
  SenderPrincipal,
  SettlementCharge,
  SettlementRequest,
} from '@hushbox/shared';
import type { WrappedSecret } from '@hushbox/crypto';
import type { DbWriter, SettlementTx } from '../../../lib/idempotency/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { ChatStores } from '../ports/stores.js';
import type { PersistItem, PersistMediaItem, PersistMessageParams } from './message-write.js';

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
 * Terminal-fails a settling turn on an ordinary concurrency conflict — the
 * captured epoch wrapped (rotation or the initiator is no longer a member), the
 * fork this turn extends vanished mid-run, or its tip moved out from under the
 * settling turn. All are races inherent to group-chat concurrency, NOT defects:
 * the throw unwinds the whole settlement transaction (nothing persists, so a
 * stale epoch never wraps and a stale tip never advances) and the engine reroutes
 * it to a friendly `{code}` outcome without a Sentry event (observability
 * doctrine). The underlying `DomainError` carries the chat-specific client wire
 * code as a `wireCode` override — `FORK_TIP_CONFLICT` for the fork-tip races,
 * `CONFLICT` for the epoch-wrap races — which the engine projects through
 * `domainWireCode`.
 *
 * The genuinely-unreachable-under-lock fork-tip CAS zero-row is deliberately NOT
 * routed here: it throws a plain `Error`, so it still surfaces as a defect +
 * Sentry (see `advanceForkTip`).
 */
function settlementConflict(
  domainError: DomainError,
  wireCode: ErrorCode,
  message: string
): SettlementConflictError {
  return new SettlementConflictError({ ...domainError, wireCode }, message);
}

const WRAP_EPOCH_CONFLICT_MESSAGE = 'chat settlement: wrap-epoch assertion failed';
const FORK_TIP_GONE_MESSAGE = 'chat settlement: fork-tip advancement failed';
const FORK_TIP_MOVED_MESSAGE =
  'chat settlement: fork tip moved after the regenerate guard validated its tail';

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
 * minted for exactly its generation. A charge whose own generation persisted
 * nothing falls back to the run's anchor (`anchorChargeKey`); a run that
 * persisted nothing at all terminal-fails before any charge is posted.
 */

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
  /**
   * The user account the run's usage is attributed to: the initiator for a user
   * turn, the OWNER for a guest turn (a guest has no account). NEVER the guest's
   * identity — that rides `sender`. Not necessarily the charged wallet's owner:
   * an owner-funded member turn debits `walletId` (the owner's wallet) while
   * this stays the member.
   */
  readonly userId: string;
  /**
   * The resolved SENDER principal (a member or a link guest, each carrying the
   * `conversation_members.id`). Present when the run-start body supplied it;
   * absent falls back to the user path keyed on `userId`. Drives
   * `messages.senderId`, the member-wrapped epoch gate, and per-member spend.
   */
  readonly sender?: SenderPrincipal;
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
  /**
   * The pre-minted persistence identities for this run's media generations,
   * keyed by the settlement charge key (`SettlementCharge.key` — the producing
   * node id, branch-suffixed under `fanOut`), so settlement joins each media
   * charge to the content item whose id the R2 key and AAD already bind.
   * Absent (or empty) for text-only turns, which stay persist-minted.
   */
  readonly mediaPlans?: ReadonlyMap<string, MediaPersistPlan>;
}

export interface ChatSettlementDeps {
  readonly identity: ChatSettlementIdentity;
  readonly stores: ChatStores;
  readonly billingStores: BillingStores;
  /**
   * The run's funding decision, recovered ONCE per run OUTSIDE this settlement
   * transaction (the caller reads wallet ownership before entering the fence)
   * and threaded in as an already-in-flight `ResultAsync`. `true` ⟺ owner-funded
   * (the owner's wallet paid; group spend accrues); `false` ⟺ solo or a personal
   * fall-through (no group spend). Consumed here without opening a second
   * connection mid-transaction; a read failure propagates and rolls the
   * settlement back.
   */
  readonly ownerFunded: ResultAsync<boolean, DomainError>;
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

/** The output content a persistable charge carries: the run's text or media final. */
type PersistableOutput =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'media'; readonly value: MediaValue };

interface PersistableCharge {
  readonly charge: SettlementCharge;
  readonly output: PersistableOutput;
}

/** A media-generation charge — the shape whose content item was pre-minted at run start. */
function isMediaModality(modality: Modality): boolean {
  return modality === 'image' || modality === 'video';
}

/**
 * The billable generations whose content the run surfaced as a persistable
 * output: a text output under any charge, or a media output under a
 * media-modality charge. A media output paired to a NON-media charge is a
 * shape mismatch, so it mints no content item of its own; the charge still
 * settles, against the run's anchor, because its node's value COMMITTED.
 *
 * Committing is the licence, and provider spend is NOT — a generation whose call
 * succeeded but whose value failed the runtime output gate never reaches this
 * function at all, because the interpreter charges after the commit and only on
 * success (pinned in `interpreter.test.ts`, "bills nothing for a sibling whose
 * value failed output validation"). So every charge here names work the run
 * accepted, which is what makes anchoring a contentless one onto the run's
 * content honest rather than an over-bill.
 *
 * An EMPTY result is the run's all-failed signal, and it is read off content
 * rather than off charge count. A run may charge for a generation that persists
 * nothing of its own — a turn-level classifier is one — so "some charge exists"
 * stopped being evidence that any branch succeeded. Reading content keeps the
 * signal true for every turn shape: no persistable content means nothing to
 * save and nothing to bill.
 */
export function collectPersistableCharges(request: SettlementRequest): PersistableCharge[] {
  const persistable: PersistableCharge[] = [];
  for (const charge of request.charges) {
    const output: (typeof request.outputs)[string] | undefined = request.outputs[charge.key];
    if (
      output !== undefined &&
      (output.kind === 'text' || (output.kind === 'media' && isMediaModality(charge.modality)))
    ) {
      persistable.push({ charge, output });
    }
  }
  return persistable;
}

async function persistTurnContent(
  tx: SettlementTx,
  request: SettlementRequest,
  deps: ChatSettlementDeps
): Promise<Map<string, string>> {
  // No persistable content is the all-failed signal. A multi-model turn
  // tolerates a subset failing (those outputs simply never arrive), but ALL
  // failing terminal-fails the run — throw to roll back so nothing persists and
  // nothing bills, and the client is told it failed rather than being told a
  // turn succeeded that saved and billed nothing.
  const persistable = collectPersistableCharges(request);
  if (persistable.length === 0) {
    throw new AllBranchesFailedError('chat settlement: no model produced content');
  }

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
  // Aggregate the run's FULL charge set by the content item each anchors to, so
  // display equals debit for every turn shape. Only persistable charges mint
  // content items, so a charge with no content of its own resolves through
  // `anchorChargeKey`'s run-level rule — the run's FIRST persisted content in
  // charge order. A turn-level classifier is that case: it has no content and no
  // parent charge that does, and naming a sibling would lose it whenever that
  // sibling is the one that failed. Pinned in `settlement.test.ts` ("anchors a
  // turn-level charge to the run's first persisted content", "takes the FIRST
  // persisted key in run order") and end-to-end in this file's integration suite
  // ("lands a turn-level classifier charge on the run's content when the first
  // sibling failed").
  const contentItemKeys = new Set(persistable.map((item) => item.charge.key));
  const displayCostByKey = aggregateDisplayCostByKey(request.charges, contentItemKeys);
  return writeGraftedTurn(ctx, { graft, epochPublicKey, persistable, displayCostByKey });
}

/**
 * The membership-gate caller for the settlement's SENDER — a member by `userId`
 * or a link guest by `linkId` (carrying the conversation it acts in). A run-start
 * body that predates the discriminated `sender` falls back to the user path keyed
 * on the payer `userId` (byte-identical to the legacy single-principal turn).
 */
function settlementCaller(identity: ChatSettlementIdentity): ConversationCaller {
  return identity.sender === undefined
    ? { kind: 'user', userId: identity.userId }
    : senderCaller(identity.sender, identity.conversationId);
}

/** The sender's principal id persisted as `messages.senderId` (linkId for a guest). */
function settlementSenderId(identity: ChatSettlementIdentity): string {
  return identity.sender === undefined ? identity.userId : senderPrincipalId(identity.sender);
}

/**
 * The sender's own user id for the solo (sender-is-owner) check — a user sender's
 * userId (the flat fallback keeps the legacy single-principal turn), or
 * `undefined` for a link guest (which holds no account and is never the owner).
 */
function settlementSenderUserId(identity: ChatSettlementIdentity): string | undefined {
  if (identity.sender === undefined) return identity.userId;
  return identity.sender.kind === 'user' ? identity.sender.userId : undefined;
}

/**
 * The sender recorded on every billed row (`ChargeSender`), independent of the
 * payer: a member sender by userId, a link guest by linkId. The flat fallback
 * (no discriminated `sender`) is a solo turn — sender and payer are the same
 * user, so both columns attribute to `identity.userId`.
 */
function settlementChargeSender(identity: ChatSettlementIdentity): ChargeSender {
  if (identity.sender === undefined) return { kind: 'user', userId: identity.userId };
  return identity.sender.kind === 'user'
    ? { kind: 'user', userId: identity.sender.userId }
    : { kind: 'linkGuest', linkId: identity.sender.linkId };
}

/**
 * The epoch-at-persist gate (forward secrecy): FOR SHARE re-read + assert the
 * send-time epoch is still current and the SENDER still belongs to it, INSIDE
 * this transaction, BEFORE wrapping — then read the wrap key. The check is
 * MEMBER-KEYED (legacy owner-billed group sends relied on this shape, and it is
 * the only one that works when the sender is a link guest with no userId): the
 * sender's decryption public key is re-resolved SERVER-SIDE from the active
 * `conversation_members` row and verified against the authoritative
 * `epoch_members` wrap-set. A departed/revoked sender resolves no key and is
 * forbidden; a stale epoch or a non-member key throws. Any failure rolls the
 * whole settlement back so content never wraps to a superseded epoch.
 */
async function resolveWrapKey(
  tx: SettlementTx,
  conversationsStores: ConversationsStoresHandle,
  deps: ChatSettlementDeps
): Promise<ReturnType<typeof asEpochPublicKey>> {
  const { identity } = deps;
  const senderKey = await resolveCallerPublicKey(
    conversationsStores,
    identity.conversationId,
    settlementCaller(identity)
  ).match(
    (key) => key,
    (error) => {
      throw settlementConflict(error, ERROR_CODES.CONFLICT, WRAP_EPOCH_CONFLICT_MESSAGE);
    }
  );
  if (senderKey === null) {
    throw settlementConflict(
      forbiddenError('chat wrap: sender is no longer an active member at settlement'),
      ERROR_CODES.CONFLICT,
      WRAP_EPOCH_CONFLICT_MESSAGE
    );
  }
  const epochCheck = await assertWrapEpochByMemberWithinTx(conversationsStores, {
    conversationId: identity.conversationId,
    expectedEpoch: identity.epochNumber,
    memberPublicKey: toBase64(senderKey),
  });
  if (epochCheck.isErr()) {
    throw settlementConflict(epochCheck.error, ERROR_CODES.CONFLICT, WRAP_EPOCH_CONFLICT_MESSAGE);
  }
  const rawKey = await deps.readEpochPublicKey(tx, identity.conversationId, identity.epochNumber);
  /* v8 ignore next 5 -- unreachable defect guard: assertWrapEpochByMemberWithinTx above already proved the epoch exists (with the member's key), so its public key is never null here */
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
  /** The full anchored display cost per content-item key (own charge + classifier). */
  readonly displayCostByKey: ReadonlyMap<string, DisplayCostAggregate>;
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
  /* v8 ignore next -- unreachable `?? []`: every key in `order` was set in byKey in the same loop, so byKey.get(key) is always defined */
  return order.map((key) => ({ key, items: byKey.get(key) ?? [] }));
}

/** The denormalized display aggregate for one content item (its full anchored total). */
interface DisplayCostAggregate {
  readonly costNanoUsd: bigint;
  readonly isSmartModel: boolean;
}

/**
 * The per-content-item DISPLAY cost: for each persisted content item (keyed by
 * its originating charge key), the SUM over EVERY charge in the run that anchors
 * to it — its own generation PLUS every contentless charge whose cost the debit
 * path FKs to the same content item, because both paths resolve the anchor
 * through the one `anchorChargeKey`. Each summand is
 * `billableCost + storageFee`, the identical value `chargeWithinTx` debits,
 * so the mirrored display total equals the wallet debit total by construction
 * (Σ content_items.cost == Σ usage_records.cost per run) and cannot drift.
 * `isSmartModel` is true iff a charge anchoring here ran the smartModel routing
 * pipeline (`smartModelRan`), which the slot sets from the turn's own shape: an
 * answer that fell back to its declared candidate because no decision reached the
 * slot badges just the same. The chip reads "the pipeline ran", never "a
 * classifier billed". The debit path is untouched — this only fills the
 * denormalized display column.
 */
function aggregateDisplayCostByKey(
  charges: readonly SettlementCharge[],
  contentItemKeys: ReadonlySet<string>
): Map<string, DisplayCostAggregate> {
  const byKey = new Map<string, DisplayCostAggregate>();
  const runChargeKeys = charges.map((charge) => charge.key);
  for (const charge of charges) {
    const anchorKey = anchorChargeKey(charge.key, (key) => contentItemKeys.has(key), runChargeKeys);
    if (anchorKey === undefined) continue;
    const cost = charge.billableCostNanoUsd + (charge.storageFeeNanoUsd ?? 0n);
    const prior = byKey.get(anchorKey);
    byKey.set(anchorKey, {
      costNanoUsd: (prior?.costNanoUsd ?? 0n) + cost,
      isSmartModel: (prior?.isSmartModel ?? false) || charge.smartModelRan === true,
    });
  }
  return byKey;
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
  const { graft, epochPublicKey, persistable, displayCostByKey } = params;
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
      displayCostByKey,
    });
  }

  // The all-failed case throws before this function, so at least one group
  // persisted and lastSiblingId is set.
  /* v8 ignore next 3 -- groups is non-empty (a run with no persistable content terminal-fails upstream), so the loop always sets lastSiblingId */
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
  readonly displayCostByKey: ReadonlyMap<string, DisplayCostAggregate>;
}

/**
 * The pre-minted persistence identity for a MEDIA group, or `undefined` for a
 * text group. A media charge with no plan is a defect (the runtime mints one
 * plan per media node BEFORE the run starts), thrown to roll the whole
 * settlement back — a media row must never mint fresh ids, because the R2
 * object and its AAD already bind the planned message/item ids.
 */
function resolveMediaPlan(
  identity: ChatSettlementIdentity,
  group: AssistantGroup
): MediaPersistPlan | undefined {
  if (!group.items.some(({ output }) => output.kind === 'media')) return undefined;
  const plan = identity.mediaPlans?.get(group.key);
  if (plan === undefined) {
    throw new Error(`chat settlement: no media persist plan for media charge "${group.key}"`);
  }
  // The shared plan type erases the WrappedSecret brand, and this row's key is
  // persisted verbatim (never re-wrapped) — an empty key from a mint-side bug
  // would commit a permanently undecryptable message, so it fails the settle.
  // Full envelope validation stays with the crypto layer at unwrap.
  if (plan.wrappedContentKey.byteLength === 0) {
    throw new Error(
      `chat settlement: empty wrapped content key in media persist plan "${group.key}"`
    );
  }
  return plan;
}

/** The `content_items` row type a MediaValue's modality maps to. */
function mediaContentType(modality: Modality): 'image' | 'video' {
  if (modality === 'image' || modality === 'video') return modality;
  // Impossible today (no audio node exists); a silent row would strand
  // undisplayable ciphertext, so an unknown modality kills the settlement.
  throw new Error(`chat settlement: unsupported media modality "${modality}" in a media output`);
}

/**
 * A best-effort numeric dimension from the MediaValue's free-form metadata.
 * Today's only producer (the media mapper) emits STRING hints (aspectRatio,
 * resolution) and no numeric width/height/durationMs, so these columns stay
 * null in practice — by design: dims are a nullable optional hint the renderer
 * tolerates missing, filled only if a future producer measures real values.
 */
function numericMetadata(metadata: MediaValue['metadata'], key: string): number | null {
  const value = metadata[key];
  return typeof value === 'number' ? value : null;
}

/**
 * Persist one assistant sibling message — reserved sentinel sender, chained onto
 * the shared parent (the new/kept user message), carrying its originating node's
 * generation(s) as content items — and record each generation's content-item id
 * against its charge key (the charge pairing). Returns the message id.
 *
 * A MEDIA sibling persists under its pre-minted plan: the run-start message id
 * and content-item id (the R2 key and AAD bind them) and the pre-supplied
 * epoch-wrapped content key. The pre-wrapped key does NOT bypass the rotation
 * serialization — `resolveWrapKey` already ran for this settlement (it gates
 * ALL persistence, before any graft), asserting the send-time epoch the plan's
 * key was wrapped to is still current and the sender still belongs to it; a
 * mid-run rotation throws a settlement conflict before any row is written.
 */
async function persistAssistantSibling(
  ctx: GraftContext,
  params: PersistSiblingParams
): Promise<string> {
  const { deps, tx } = ctx;
  const mediaPlan = resolveMediaPlan(deps.identity, params.group);
  const assistantMessageId = mediaPlan?.assistantMessageId ?? deps.newId();
  const contentIds = await persistMessage(tx, deps, {
    messageId: assistantMessageId,
    epochPublicKey: params.epochPublicKey,
    senderType: 'assistant',
    senderId: ASSISTANT_SENDER_ID,
    sequenceNumber: params.sequenceNumber,
    parentMessageId: params.parentMessageId,
    batchId: params.batchId,
    // The wrapped content key minted at run start (the media ciphertext in R2
    // is already encrypted under it); a text sibling mints its own at persist.
    ...(mediaPlan === undefined
      ? {}
      : { wrappedContentKey: mediaPlan.wrappedContentKey as WrappedSecret }),
    items: params.group.items.map(({ charge, output }) => {
      // The full charged cost, mirrored for display reads so display equals debit:
      // the SUM of every charge anchored to this content item — its own generation
      // (marked-up model cost + additive storage fee) PLUS every contentless
      // charge the debit path FKs to the same item. The aggregate derives each
      // summand from the SAME storage-fee-bearing charge `chargeWithinTx` debits,
      // so the two cannot diverge.
      const aggregate = params.displayCostByKey.get(charge.key);
      /* v8 ignore next 3 -- every persistable charge key seeds its own aggregate entry (its own key IS a content-item key), so a miss is an unreachable invariant break */
      if (aggregate === undefined) {
        throw new Error('chat settlement: no display-cost aggregate for a persisted content item');
      }
      const display = {
        modelId: charge.modelId,
        providerName: charge.providerName,
        cost: aggregate.costNanoUsd,
        isSmartModel: aggregate.isSmartModel,
      };
      if (output.kind === 'text') {
        return { text: output.text, ...display } satisfies PersistItem;
      }
      /* v8 ignore next 3 -- a group is homogeneous (one key, one output), so a media output always resolved a plan above */
      if (mediaPlan === undefined) {
        throw new Error('chat settlement: media item persisted without a resolved plan');
      }
      return {
        contentType: mediaContentType(output.value.modality),
        id: mediaPlan.contentItemId,
        storageKey: output.value.ref,
        mimeType: output.value.mimeType,
        // The CIPHERTEXT length the mapper measured after encryption — what R2
        // actually stores, and what the storage fee already billed.
        sizeBytes: output.value.byteLength,
        width: numericMetadata(output.value.metadata, 'width'),
        height: numericMetadata(output.value.metadata, 'height'),
        durationMs: numericMetadata(output.value.metadata, 'durationMs'),
        ...display,
      } satisfies PersistMediaItem;
    }),
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
    // The SENDER's principal id — a member's userId, a link guest's linkId —
    // never the paying owner (a guest turn's payer is the owner).
    senderId: settlementSenderId(deps.identity),
    sequenceNumber: userSequence,
    parentMessageId: graft.userInsert.parentMessageId,
    batchId: block.batchId,
    items: [
      {
        text: graft.userInsert.content,
        modelId: null,
        providerName: null,
        cost: null,
        isSmartModel: false,
      },
    ],
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
    throw settlementConflict(
      conflictError('chat settlement: fork tip moved before the regenerate could settle'),
      ERROR_CODES.FORK_TIP_CONFLICT,
      FORK_TIP_MOVED_MESSAGE
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
  if (resolved.isErr()) {
    throw settlementConflict(resolved.error, ERROR_CODES.FORK_TIP_CONFLICT, FORK_TIP_GONE_MESSAGE);
  }
  return resolved.value.tipMessageId;
}

/**
 * Advances a fresh-send fork's tip: CAS it from the prior tip (the parent the
 * messages chained onto) to the new assistant reply, through the same
 * IS-NOT-DISTINCT-FROM CAS the `PUT /tip` route uses. Under the fork-row lock
 * the resolve step took, the CAS always holds; a zero-row outcome is an
 * unreachable concurrency defect — it throws a plain `Error` (NOT the
 * `SettlementConflictError` sentinel), so it rolls the whole settlement back AND
 * still surfaces as a defect + Sentry, unlike the expected fork-tip/epoch-wrap
 * races.
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
  /* v8 ignore next 4 -- the fork-row lock the resolve step holds guarantees the CAS matches its own locked tip; a zero-row outcome is an unreachable concurrency defect, guarded defensively */
  if (advanced.isErr()) {
    throw new Error('chat settlement: fork-tip advancement failed', { cause: advanced.error });
  }
}

/**
 * Persist one message and its content items through the shared insert
 * primitive (`persistEncryptedMessage` — the run settlement and the runless
 * user-only send compose the SAME implementation), bound to this settlement's
 * conversation/epoch identity. Returns the minted content-item ids in item
 * order.
 */
async function persistMessage(
  tx: SettlementTx,
  deps: ChatSettlementDeps,
  params: PersistMessageParams
): Promise<string[]> {
  return persistEncryptedMessage(
    tx,
    {
      stores: deps.stores,
      conversationId: deps.identity.conversationId,
      epochNumber: deps.identity.epochNumber,
      newId: deps.newId,
    },
    params
  );
}

/** The sender's group attribution for an owner-funded group turn; `null` otherwise. */
interface MemberBudgetAttribution {
  readonly memberId: string;
  readonly conversationId: string;
}

/**
 * Resolves the SENDER's group attribution INSIDE the settlement transaction, so
 * the member- and conversation-spend writes commit atomically with the content
 * and charges. Group spend is accrued ONLY for an OWNER-FUNDED group turn: the
 * owner's wallet paid, so both the sender's durable per-member row and the
 * durable per-conversation row accrue the charge. Two cases attribute nothing:
 *   - a SOLO turn (sender is the owner — the owner funds and is not member-capped);
 *   - a PERSONAL fall-through group turn (the sender self-funded on their own
 *     wallet because the group headroom was ≤ 0 — no group spend is written).
 * Owner-funding is recovered ONCE per run from the payer wallet the route froze
 * (`deps.ownerFunded`, read outside this transaction and threaded in), so
 * attribution agrees with the payer and with the admission scopes by
 * construction — and no second connection opens mid-settlement. Two cases
 * attribute nothing:
 *   - a SOLO turn (a USER sender who owns the conversation — the owner funds and
 *     is not member-capped; a link guest is never the owner);
 *   - a PERSONAL fall-through group turn (`ownerFunded` false — the sender
 *     self-funded on their own wallet).
 * The per-member CAP is never resolved here: it is durable owner-set config the
 * admission gate already enforced; settlement only accrues cumulative spend
 * (member + conversation rows, keyed by id, no period). The member is re-resolved
 * SERVER-SIDE from the SENDER principal (a user by `userId`, a guest by `linkId`)
 * via the same `resolveCallerMember` gate the epoch check uses — never from a
 * client-supplied member id. A running turn always has a live conversation row
 * and (when owner-funded) an active sender membership, so both null guards are
 * unreachable defensive checks. An infra read failure throws, rolling the whole
 * settlement back.
 */
function resolveMemberBudgetAttribution(
  tx: SettlementTx,
  deps: ChatSettlementDeps
): Promise<MemberBudgetAttribution | null> {
  const conversationsStores = deps.conversationsStores
    ? deps.conversationsStores(tx)
    : createConversationsStores(tx);
  const { identity } = deps;
  const { conversationId } = identity;
  const senderUserId = settlementSenderUserId(identity);
  return conversationsStores.conversations
    .get(conversationId)
    .andThen((conversation) => {
      /* v8 ignore next 3 -- unreachable: a running turn always has a live conversation row and this settlement holds the transaction open, so the read never returns null */
      if (conversation === null) {
        return okAsync<MemberBudgetAttribution | null, DomainError>(null);
      }
      // Solo turn: the sender IS the owner (users only) — the owner funds and is
      // not attributed to a member budget.
      if (senderUserId !== undefined && conversation.ownerUserId === senderUserId) {
        return okAsync<MemberBudgetAttribution | null, DomainError>(null);
      }
      return deps.ownerFunded.andThen((ownerFunded) => {
        // Personal fall-through: the sender self-funded on their own wallet, so
        // no group spend is written.
        if (!ownerFunded) {
          return okAsync<MemberBudgetAttribution | null, DomainError>(null);
        }
        return resolveCallerMember(
          conversationsStores,
          conversationId,
          settlementCaller(identity)
        ).map((member) => {
          /* v8 ignore next -- the epoch gate asserted active membership; a null member here is unreachable */
          if (member === null) return null;
          return { memberId: member.id, conversationId };
        });
      });
    })
    .match(
      (attribution) => attribution,
      (error) => {
        throw new Error('chat settlement: member-budget read failed', { cause: error });
      }
    );
}

/**
 * Attaches the additive storage fee to each charge (nano-USD, never marked up).
 * Text storage = (chars) × per-char rate over the NEW turn only — the persisted
 * user prompt plus this generation's response — never the resent history. Media
 * storage = artifact bytes × per-byte rate. The shared user prompt is stored
 * ONCE per turn, so its char cost is attributed to exactly one charge; every
 * branch still carries its own response (and media) storage.
 *
 * That one charge is the first PERSISTED charge, not the first charge. A run
 * may charge for a generation that persists nothing of its own — a turn-level
 * classifier is one, and it charges before any sibling — so declaration order
 * alone no longer names a charge whose own content item can carry the fee. This
 * guarantees the fee rides a charge that minted content, which is what keeps the
 * whole prompt fee on one item in both the debit and the display.
 */
export function withStorageFees(
  request: SettlementRequest,
  promptChars: number
): SettlementCharge[] {
  const promptFee = BigInt(promptChars) * STORAGE_COST_PER_CHARACTER_NANO;
  const promptFeeKey = collectPersistableCharges(request)[0]?.charge.key;
  return request.charges.map((charge) => {
    const output = request.outputs[charge.key];
    const responseChars = output?.kind === 'text' ? output.text.length : 0;
    const responseFee = BigInt(responseChars) * STORAGE_COST_PER_CHARACTER_NANO;
    const mediaFee = BigInt(mediaBytesOf(output)) * MEDIA_STORAGE_COST_PER_BYTE_NANO;
    const promptShare = charge.key === promptFeeKey ? promptFee : 0n;
    return { ...charge, storageFeeNanoUsd: promptShare + responseFee + mediaFee };
  });
}

/** The persisted byte length of a media output, or 0 for text/absent outputs. */
function mediaBytesOf(output: SettlementRequest['outputs'][string] | undefined): number {
  if (output?.kind === 'media') return output.value.byteLength;
  if (output?.kind === 'bytes') return output.bytes.length;
  return 0;
}

export function createChatSettlementCommit(deps: ChatSettlementDeps): SettlementCommit {
  return async (tx, request) => {
    // Enrich every charge with its additive storage fee ONCE, up front, then feed
    // the SAME settled request to both content persistence and the charge. Display
    // must equal debit: the persisted content cost and the wallet charge derive
    // from one storage-fee value, so they cannot diverge.
    const charges = withStorageFees(request, deps.identity.userMessage.content.length);
    const settled: SettlementRequest = { ...request, charges };
    const contentItemIdByKey = await persistTurnContent(tx, settled, deps);
    const memberBudget = await resolveMemberBudgetAttribution(tx, deps);
    const charging = createChargingCommit({
      stores: deps.billingStores,
      context: {
        walletId: deps.identity.walletId,
        userId: deps.identity.userId,
        sender: settlementChargeSender(deps.identity),
        runId: deps.identity.runId,
        now: deps.now(),
        contentItemIdFor: (key) => contentItemIdByKey.get(key),
        ...(memberBudget === null ? {} : { memberBudget }),
      },
    });
    await charging(tx, settled);
    // Stamp the conversation onto every usage record of this run (keyed by
    // runId) so per-conversation spend analytics can group by it. Runs for all
    // turn shapes — solo and group — where `chargeWithinTx`'s group-only
    // `conversationId` never reaches a solo turn's usage record.
    await deps.billingStores.stampRunConversationWithinTx(
      tx,
      deps.identity.runId,
      deps.identity.conversationId
    );
  };
}
