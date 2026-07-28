import { runSettlement, succeedKeyRow } from '../../../lib/idempotency/index.js';
import { chargeWithinTx } from '../../billing/index.js';
import type { SettlementCharge, SettlementHook, SettlementRequest } from '@hushbox/shared';
import type { Database } from '@hushbox/db';
import type { KeyRowFence, SettlementTx } from '../../../lib/idempotency/index.js';
import type { BillingStores, ChargeInput, ChargeSender } from '../../billing/index.js';

/**
 * The settlement-hook plumbing: the generic fenced runner every definition's
 * settlement policy plugs into. Nothing commits mid-run; the
 * whole settlement — content persistence, every node's charge, and the
 * key-row flip — commits in ONE `runSettlement` transaction, fenced by the
 * idempotency-key row. A run that lost its claim (a zombie or a superseding
 * retry) flips nothing and rolls the transaction back, so charges are
 * exactly-once by construction (saved ⟺ billed ⟺ key flipped, atomically).
 * The content+charge writer and the run's charge inputs are the settling
 * slice's (chat's `saveChatTurn` + `chargeWithinTx`), injected here.
 */

/** The run lost its key-row claim at settlement; nothing committed. */
export class SettlementFenceLost extends Error {
  constructor() {
    super('settlement lost its idempotency-key claim');
    this.name = 'SettlementFenceLost';
  }
}

/** The key-row store was unavailable at settlement; the transaction rolls back. */
export class SettlementCompletionError extends Error {
  constructor(cause: unknown) {
    super('settlement key-row completion failed', { cause });
    this.name = 'SettlementCompletionError';
  }
}

/** Persists content + charges within the settlement transaction. */
export type SettlementCommit = (tx: SettlementTx, request: SettlementRequest) => Promise<void>;

/** The fenced `claimed → succeeded` flip; production wires `keyRowCompletion`. */
export type KeyRowCompletion = (
  tx: SettlementTx,
  fence: KeyRowFence
) => Promise<'flipped' | 'lost'>;

export interface FencedSettlementDeps {
  readonly db: Database;
  readonly fence: KeyRowFence;
  readonly complete: KeyRowCompletion;
  readonly commit: SettlementCommit;
}

export function createFencedSettlementHook(deps: FencedSettlementDeps): SettlementHook {
  return (request) =>
    runSettlement(deps.db, async (tx) => {
      await deps.commit(tx, request);
      const outcome = await deps.complete(tx, deps.fence);
      if (outcome === 'lost') throw new SettlementFenceLost();
    });
}

/**
 * Production wiring of the fence flip over the idempotency-key row: the
 * `succeedKeyRow` fenced transition stores the replayable response and yields
 * `'lost'` when a zombie claimant reaches the fence. An infra error throws
 * (rolling the settlement back), never resolves to a silent outcome.
 */
export function keyRowCompletion(response: unknown): KeyRowCompletion {
  return (tx, fence) =>
    succeedKeyRow(tx, fence, response).match(
      (outcome) => outcome,
      (error) => {
        throw new SettlementCompletionError(error);
      }
    );
}

/**
 * The run-scoped facts every charge shares, closed over from the `RunContext`
 * the DO threads into the settlement hook: who pays (`walletId`/`userId`), the
 * run grouping id, the settlement timestamp, and the persist-then-charge seam.
 *
 * `contentItemIdFor` is the documented handoff to the chat slice's persist
 * seam: a charge is anchored to the content persisted for its generation, and
 * that content item is minted inside this same settlement transaction, before
 * the charge. This generic commit knows nothing about content persistence — it
 * maps a charge's stable `key` to the content id the chat slice persisted for
 * it. Which key a charge resolves against is `anchorChargeKey`'s rule; a run
 * that persisted no content at all resolves none of them, so it bills nothing.
 */
export interface ChargeContext {
  readonly walletId: string;
  readonly userId: string;
  /**
   * The turn's SENDER principal, stamped on every charge of the run beside
   * the attributed user (`userId`). They diverge on a link-guest turn —
   * `userId` is the OWNER, the guest has no users row. On a user turn `userId`
   * is the sending member, owner-funded or not: owner funding moves only the
   * charged wallet. Both are self on a solo turn.
   */
  readonly sender: ChargeSender;
  readonly runId: string;
  readonly now: Date;
  readonly contentItemIdFor: (key: string) => string | undefined;
  /**
   * The run initiator's group attribution — the SENDER's member id plus the
   * conversation id — present only for a group turn (sender ≠ owner). When set,
   * every charge accrues its marked-up cost cumulatively to the member's durable
   * row AND the conversation's durable spend row (both keyed by id, no period).
   * The member row's owner-set cap is never touched by a spend (the insert-path
   * cap is the zero insert-default `0`); the cap is configured out of band. Absent for a
   * solo/owner turn — the owner funds and is not member-capped, so no member or
   * conversation spend is written.
   */
  readonly memberBudget?: { readonly memberId: string; readonly conversationId: string };
}

export interface ChargingCommitDeps {
  readonly stores: BillingStores;
  readonly context: ChargeContext;
}

/**
 * A `SettlementCommit` that posts every collected per-generation charge through
 * billing's published `chargeWithinTx`, deriving each `ChargeInput` from the
 * generation's own facts (the `SettlementCharge` record) plus the run context.
 * Each charge is DB-idempotent on its unique key, so a replayed settlement
 * converges on the first execution's rows.
 */
export function createChargingCommit(deps: ChargingCommitDeps): SettlementCommit {
  return async (tx, request) => {
    const runChargeKeys = request.charges.map((charge) => charge.key);
    for (const charge of request.charges) {
      const contentItemId = anchorContentItemId(
        charge.key,
        deps.context.contentItemIdFor,
        runChargeKeys
      );
      if (contentItemId === undefined) continue;
      await chargeWithinTx(deps.stores, tx, chargeInputFor(charge, contentItemId, deps.context));
    }
  };
}

/**
 * A charge's content anchor, resolved nearest-first over three rules:
 *
 * 1. the content persisted for the charge's OWN key;
 * 2. the content persisted for its base node — charge keys nest (a fanOut branch
 *    is `<node>#<index>`, and the interpreter suffixes an auxiliary generation
 *    once more), so this strips the LAST suffix segment only, never down to the
 *    bare node id;
 * 3. the RUN's own anchor: the first key in `runChargeKeys` that persisted
 *    content.
 *
 * Rule 3 is what keeps a charge whose generation persists nothing of its own
 * billed rather than absorbed — a turn-level classifier has no content and no
 * parent that does, and naming a sibling would not help, since that sibling may
 * be the one that failed. `runChargeKeys` is the run's charge keys in the order
 * the interpreter collected them, which is the definition's topological order,
 * so the anchor is the same content item on every replay of the same run.
 *
 * `undefined` means the RUN persisted nothing, and no charge of it may land:
 * `usage_records` is inserted with a non-null content item, so billed ⟹ the run
 * persisted content.
 *
 * Both the wallet debit and the displayed per-item cost anchor through this one
 * function, so a charge cannot be debited against one content item and
 * displayed on another.
 */
export function anchorChargeKey(
  key: string,
  persistedContentFor: (key: string) => boolean,
  runChargeKeys: readonly string[]
): string | undefined {
  if (persistedContentFor(key)) return key;
  const separator = key.lastIndexOf('#');
  if (separator !== -1) {
    const base = key.slice(0, separator);
    if (persistedContentFor(base)) return base;
  }
  return runChargeKeys.find((candidate) => persistedContentFor(candidate));
}

/** The content item a charge's anchor names, resolved through the one rule above. */
function anchorContentItemId(
  key: string,
  contentItemIdFor: ChargeContext['contentItemIdFor'],
  runChargeKeys: readonly string[]
): string | undefined {
  const anchor = anchorChargeKey(
    key,
    (candidate) => contentItemIdFor(candidate) !== undefined,
    runChargeKeys
  );
  return anchor === undefined ? undefined : contentItemIdFor(anchor);
}

/**
 * Builds the `ChargeInput` from a per-generation record and the run context:
 * the model facts and billable cost from the record, who-pays and the run
 * grouping from the context, and the DB-idempotency key derived from
 * `(runId, key)` — unique per generation per run. The cost is charged as-is —
 * fees were applied at the seams, never here or downstream.
 */
function chargeInputFor(
  charge: SettlementCharge,
  contentItemId: string,
  context: ChargeContext
): ChargeInput {
  return {
    walletId: context.walletId,
    userId: context.userId,
    sender: context.sender,
    runId: context.runId,
    contentItemId,
    modelId: charge.modelId,
    providerName: charge.providerName,
    modality: charge.modality,
    ...(charge.generationId === undefined ? {} : { generationId: charge.generationId }),
    billableCostNanoUsd: charge.billableCostNanoUsd,
    storageFeeNanoUsd: charge.storageFeeNanoUsd ?? 0n,
    isEstimated: charge.isEstimated,
    ...(charge.tokens === undefined ? {} : { tokens: charge.tokens }),
    ...(charge.media === undefined ? {} : { media: charge.media }),
    ...(charge.reasoningEffort === undefined ? {} : { reasoningEffort: charge.reasoningEffort }),
    idempotencyKey: `${context.runId}:${charge.key}`,
    now: context.now,
    // A group turn attributes cumulative spend to both the sender's member row
    // and the conversation's spend row. The member insert-path cap is the
    // zero insert-default `0` (a correctly-gated turn already has an owner-set row, so
    // this only ever hits ON CONFLICT and preserves the configured cap; the `0`
    // is a should-never-insert fallback, never a permissive conversation cap).
    ...(context.memberBudget === undefined
      ? {}
      : {
          memberBudget: { memberId: context.memberBudget.memberId, budgetNanoUsd: 0n },
          conversationId: context.memberBudget.conversationId,
        }),
  };
}
