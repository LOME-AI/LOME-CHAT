import { runSettlement, succeedKeyRow } from '../../../lib/idempotency/index.js';
import { chargeWithinTx } from '../../billing/index.js';
import type { SettlementCharge, SettlementHook, SettlementRequest } from '@hushbox/shared';
import type { Database } from '@hushbox/db';
import type { KeyRowFence, SettlementTx } from '../../../lib/idempotency/index.js';
import type { BillingStores, ChargeInput } from '../../billing/index.js';

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
 * it. `undefined` means no content was persisted for that key, so the charge is
 * skipped (saved ⟺ billed — no content, no charge).
 */
export interface ChargeContext {
  readonly walletId: string;
  readonly userId: string;
  readonly runId: string;
  readonly now: Date;
  readonly contentItemIdFor: (key: string) => string | undefined;
  /**
   * The run initiator's group member-budget attribution, present only for a
   * group turn against a conversation with a configured budget. When set, every
   * charge accrues its marked-up cost to the member's period row (the cap
   * snapshot rides along), so the per-period budget the admission read enforces
   * grows cumulatively. Absent for solo/unconfigured turns — no member-spend
   * write, so admission finds no row and treats the member as unlimited.
   */
  readonly memberBudget?: { readonly memberId: string; readonly budgetNanoUsd: bigint };
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
    for (const charge of request.charges) {
      const contentItemId = anchorContentItemId(charge.key, deps.context.contentItemIdFor);
      if (contentItemId === undefined) continue;
      await chargeWithinTx(deps.stores, tx, chargeInputFor(charge, contentItemId, deps.context));
    }
  };
}

/**
 * A charge's content anchor: the content persisted for its own key, or —
 * for a `#`-suffixed key with no content of its own (a smartModel classifier
 * generation, keyed `<node>#classifier`) — the content persisted for its base
 * node. Keeps the saved ⟺ billed FK: an auxiliary generation bills against
 * the content its node persisted, and skips (like any charge) when the node
 * persisted nothing. Charge keys nest (a fanOut branch is `<node>#<index>`,
 * its classifier `<node>#<index>#classifier`), so the anchor is the charge
 * key minus its LAST suffix segment — never the bare node id.
 */
function anchorContentItemId(
  key: string,
  contentItemIdFor: ChargeContext['contentItemIdFor']
): string | undefined {
  const own = contentItemIdFor(key);
  if (own !== undefined) return own;
  const separator = key.lastIndexOf('#');
  if (separator === -1) return undefined;
  return contentItemIdFor(key.slice(0, separator));
}

/**
 * Builds the `ChargeInput` from a per-generation record and the run context:
 * the model facts and base (pre-markup) cost from the record, who-pays and the
 * run grouping from the context, and the DB-idempotency key derived from
 * `(runId, key)` — unique per generation per run. The 15% markup lands once,
 * downstream in `chargeWithinTx`.
 */
function chargeInputFor(
  charge: SettlementCharge,
  contentItemId: string,
  context: ChargeContext
): ChargeInput {
  return {
    walletId: context.walletId,
    userId: context.userId,
    runId: context.runId,
    contentItemId,
    modelId: charge.modelId,
    providerName: charge.providerName,
    modality: charge.modality,
    ...(charge.generationId === undefined ? {} : { generationId: charge.generationId }),
    baseCostNanoUsd: charge.baseCostNanoUsd,
    isEstimated: charge.isEstimated,
    idempotencyKey: `${context.runId}:${charge.key}`,
    now: context.now,
    ...(context.memberBudget === undefined ? {} : { memberBudget: context.memberBudget }),
  };
}
