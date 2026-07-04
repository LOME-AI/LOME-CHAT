import { z } from 'zod';
import { notFoundError, unavailableError, validationError } from '../../../lib/errors/index.js';
import { runSettlement } from '../../../lib/idempotency/index.js';
import { enqueueWithinTx, jobOutcome } from '../../../lib/jobs/index.js';
import { errAsync, fromPromise, okAsync } from '../../../lib/result/index.js';
import { COST_CIRCUIT_MULTIPLIER } from './constants.js';
import { applyMarkup, usdToNanoUsd } from './money.js';
import type { Database } from '@hushbox/db';
import type { DomainError } from '../../../lib/errors/index.js';
import type { DbWriter, SettlementTx } from '../../../lib/idempotency/index.js';
import type {
  EnqueueJobResult,
  JobOutcome,
  JobRegistration,
  JobRegistry,
} from '../../../lib/jobs/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { BillingStores, GenerationCostClient, UsageRecordRow } from '../ports/index.js';

/**
 * True-up: settlement charged the observed-usage estimate (`isEstimated`);
 * the gateway's authoritative per-generation cost lands afterwards as a
 * zero-sum `true_up` adjustment leg pair, clearing the flag. Attempted
 * inline by the DO right after settlement; the job (enqueued in the
 * settlement transaction, deduped per record) is the retry path with the
 * dispatcher's backoff. An estimate is never accepted as final: exhausted
 * retries dead-letter the job at claim time, the record stays `isEstimated`
 * (the client's `~`-marked display state), and the dead row — which lives
 * forever — is the durable audit trail until an admin fixes the cause and
 * redrives it.
 */

export const TRUE_UP_JOB_TYPE = 'trueup.fetch.v1';

/**
 * Failure budget before the dispatcher dead-letters the row at claim time.
 * With the dispatcher's `failures⁴s` backoff this spans roughly seven hours
 * of retries against gateway indexing lag.
 */
export const TRUE_UP_MAX_FAILURES = 10;

/**
 * Sanity ceiling on the gateway's authoritative cost, as a multiple of the
 * settled estimate. K (the cost circuit's multiplier) is the natural bound:
 * the circuit kills any run whose observed accrual exceeds `hold × K`, so a
 * genuine cost cannot exceed the observed-usage estimate by more than K — a
 * larger value is a mis-indexed or corrupt gateway response and must never
 * post as a debit. Rejection is a retriable failure; if the gateway keeps
 * answering absurdly the job dead-letters at the failure cap for explicit
 * human investigation.
 */
export const TRUE_UP_COST_CEILING_MULTIPLIER = COST_CIRCUIT_MULTIPLIER;

const trueUpPayloadSchema = z.object({ usageRecordId: z.uuid() });

export type TrueUpStatus = 'trued-up' | 'unchanged' | 'already-final';

export interface TrueUpDeps {
  readonly db: Database;
  readonly stores: BillingStores;
  readonly generationCost: GenerationCostClient;
}

/**
 * Finalizes the record and, when the authoritative cost differs, posts the
 * adjustment legs — all inside one settlement transaction. The
 * `finalizeWithinTx` hook is the job handler's fenced terminal transition
 * (txn idempotency class); inline callers omit it. The `UPDATE … WHERE
 * is_estimated` transition is the race fence: the loser observes 0 rows and
 * writes no legs.
 */
interface SettleTrueUpArgs {
  readonly stores: BillingStores;
  readonly record: UsageRecordRow;
  readonly authoritativeNanoUsd: bigint;
  readonly walletId: string | null;
  readonly finalizeWithinTx?: (tx: SettlementTx) => Promise<JobOutcome>;
}

async function settleTrueUp(
  tx: SettlementTx,
  { stores, record, authoritativeNanoUsd, walletId, finalizeWithinTx }: SettleTrueUpArgs
): Promise<{ status: TrueUpStatus; outcome: JobOutcome | null }> {
  const finalized = await stores.finalizeUsageRecordCostWithinTx(
    tx,
    record.id,
    authoritativeNanoUsd
  );
  const finish = async (
    status: TrueUpStatus
  ): Promise<{ status: TrueUpStatus; outcome: JobOutcome | null }> => ({
    status,
    outcome: finalizeWithinTx === undefined ? null : await finalizeWithinTx(tx),
  });
  if (!finalized) return finish('already-final');
  const deltaNanoUsd = authoritativeNanoUsd - record.costNanoUsd;
  if (deltaNanoUsd === 0n) return finish('unchanged');
  if (walletId === null) {
    throw new Error('true-up: usage record has no charge wallet leg');
  }
  const wallet = await stores.lockWalletWithinTx(tx, walletId);
  const balanceAfter = wallet.balanceNanoUsd - deltaNanoUsd;
  const transactionId = crypto.randomUUID();
  await stores.insertLedgerLegsWithinTx(tx, [
    {
      transactionId,
      kind: 'true_up',
      amountNanoUsd: -deltaNanoUsd,
      balanceAfterNanoUsd: balanceAfter,
      walletId,
      usageRecordId: record.id,
      idempotencyKey: `trueup:${record.id}:user`,
    },
    {
      transactionId,
      kind: 'true_up',
      amountNanoUsd: deltaNanoUsd,
      houseAccount: 'revenue',
      usageRecordId: record.id,
      idempotencyKey: `trueup:${record.id}:house`,
    },
  ]);
  await stores.updateWalletBalanceWithinTx(tx, walletId, balanceAfter, wallet.ledgerSeq + 1n);
  return finish('trued-up');
}

function loadEstimatedRecord(
  deps: Pick<TrueUpDeps, 'db' | 'stores'>,
  usageRecordId: string
): ResultAsync<UsageRecordRow | 'already-final', DomainError> {
  return deps.stores.readUsageRecord(deps.db, usageRecordId).andThen((record) => {
    if (record === null) {
      return errAsync(notFoundError('true-up: usage record does not exist'));
    }
    return okAsync(record.isEstimated ? record : ('already-final' as const));
  });
}

function fetchAuthoritativeCost(
  deps: TrueUpDeps,
  record: UsageRecordRow
): ResultAsync<bigint, DomainError> {
  if (record.generationId === null) {
    return errAsync(validationError('true-up: usage record carries no generation id'));
  }
  return deps.generationCost.fetchGenerationInfo(record.generationId).andThen((info) => {
    if (info.totalCostUsd < 0) {
      return errAsync(validationError('true-up: negative provider cost rejected, not credited'));
    }
    const authoritativeNanoUsd = applyMarkup(usdToNanoUsd(info.totalCostUsd));
    if (authoritativeNanoUsd > record.costNanoUsd * TRUE_UP_COST_CEILING_MULTIPLIER) {
      return errAsync(
        validationError('true-up: gateway cost exceeds the sanity ceiling, not debited')
      );
    }
    return okAsync(authoritativeNanoUsd);
  });
}

function settleAuthoritative(
  deps: TrueUpDeps,
  record: UsageRecordRow,
  authoritativeNanoUsd: bigint
): ResultAsync<TrueUpStatus, DomainError> {
  return deps.stores.readUsageChargeWallet(deps.db, record.id).andThen((walletId) =>
    fromPromise(
      runSettlement(deps.db, (tx) =>
        settleTrueUp(tx, { stores: deps.stores, record, authoritativeNanoUsd, walletId })
      ),
      (cause) => unavailableError('true-up settlement failed', cause)
    ).map((settled) => settled.status)
  );
}

/** The inline path the DO runs right after settlement (a miss enqueues nothing — the job already exists). */
export function applyTrueUp(
  deps: TrueUpDeps,
  args: { readonly usageRecordId: string }
): ResultAsync<TrueUpStatus, DomainError> {
  return loadEstimatedRecord(deps, args.usageRecordId).andThen((record) => {
    if (record === 'already-final') return okAsync<TrueUpStatus, DomainError>('already-final');
    return fetchAuthoritativeCost(deps, record).andThen((authoritativeNanoUsd) =>
      settleAuthoritative(deps, record, authoritativeNanoUsd)
    );
  });
}

/**
 * `trueup.fetch.v1` — txn idempotency class: the adjustment and the fenced
 * terminal transition commit in one settlement transaction via
 * `completeWithinTx`, so redelivery can never double-post.
 */
export function createTrueUpJobRegistration(
  deps: TrueUpDeps
): JobRegistration<typeof trueUpPayloadSchema> {
  return {
    type: TRUE_UP_JOB_TYPE,
    schema: trueUpPayloadSchema,
    leaseSeconds: 60,
    maxFailures: TRUE_UP_MAX_FAILURES,
    idempotency: 'txn',
    handler: async (execution) => {
      const { usageRecordId } = execution.payload;
      const loaded = await loadEstimatedRecord(deps, usageRecordId);
      if (loaded.isErr()) {
        const error = loaded.error;
        return error.code === 'not_found'
          ? jobOutcome.dead('usage record does not exist')
          : jobOutcome.fail(error.code);
      }
      const record = loaded.value;
      if (record === 'already-final') return jobOutcome.ok('already-final');
      // No generation id means no gateway cost can ever land — dead-letter
      // immediately; the record stays `isEstimated` until an admin resolves
      // the dead row.
      if (record.generationId === null) {
        return jobOutcome.dead('usage record carries no generation id');
      }
      // A fetch failure only ever retries; at the failure cap the dispatcher
      // dead-letters the row — the estimate is never accepted as final.
      const cost = await fetchAuthoritativeCost(deps, record);
      if (cost.isErr()) return jobOutcome.fail(cost.error.code);
      const walletId = await deps.stores.readUsageChargeWallet(deps.db, record.id);
      if (walletId.isErr()) return jobOutcome.fail(walletId.error.code);
      // settleTrueUp invokes the finalize hook on every path, so the capture
      // below is always assigned before the transaction commits.
      let outcome: JobOutcome = jobOutcome.fail('true-up completion was never written');
      await runSettlement(deps.db, (tx) =>
        settleTrueUp(tx, {
          stores: deps.stores,
          record,
          authoritativeNanoUsd: cost.value,
          walletId: walletId.value,
          finalizeWithinTx: async (innerTx) => {
            outcome = await execution.completeWithinTx(innerTx);
            return outcome;
          },
        })
      );
      return outcome;
    },
  };
}

/**
 * Pattern C enqueue: an INSERT in the caller's (settlement) transaction,
 * deduped per usage record so a retried settlement never double-enqueues.
 */
export function enqueueTrueUpWithinTx(
  tx: DbWriter,
  registry: JobRegistry,
  args: { readonly usageRecordId: string }
): Promise<EnqueueJobResult> {
  return enqueueWithinTx(tx, registry, {
    type: TRUE_UP_JOB_TYPE,
    payload: { usageRecordId: args.usageRecordId },
    dedupeKey: `trueup:${args.usageRecordId}`,
  });
}
