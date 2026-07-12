import { notFoundError, unavailableError, validationError } from '../../../lib/errors/index.js';
import { errAsync, fromPromise, okAsync } from '../../../lib/result/index.js';
import { ADMISSION_SCRIPT, SNAPSHOT_CAS_SCRIPT } from './admission-scripts.js';
import { COST_CIRCUIT_MULTIPLIER, HOLD_TTL_MARGIN_SECONDS } from './constants.js';
import { BILLING_KEYS, MAX_HOLD_TTL_SECONDS } from './keys.js';
import type { Database } from '@hushbox/db';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { BillingStores, WalletType } from '../ports/index.js';
import type { RedisClient } from './keys.js';

/**
 * Admission — the ONLY balance gate in the system (settlement charges
 * unguarded; negative balances are legal). One atomic Redis Lua
 * check-and-add: balance snapshot − Σ active holds ≥ estimate, the cumulative
 * member/conversation budget scopes, the per-wallet concurrent-run cap — then
 * the TTL hold. The
 * hold is not money — it auto-expires; the ledger is the durable truth.
 *
 * Redis down ⇒ paid admission fails CLOSED with a typed `unavailable` error
 * (the route/engine maps it to ADMISSION_UNAVAILABLE). There is no degraded
 * mode: without holds, unguarded settlement would mean unbounded negative
 * exposure.
 */

/** A cumulative budget the run must fit, read from the durable owner-set rows. */
export interface BudgetScope {
  /**
   * The scope's Redis holds-hash key (e.g. `member:<memberId>` or
   * `conversation:<conversationId>`) — cumulative, no period/month suffix and
   * no rollover.
   */
  readonly scopeId: string;
  /** Owner-set cap minus the row's cumulative spent — computed by the caller from Postgres. */
  readonly remainingNanoUsd: bigint;
}

export interface AdmissionRequest {
  readonly walletId: string;
  /** The run's id — one hold per run, released at settlement or by TTL. */
  readonly holdId: string;
  /** Priced at the declared ceiling (max width × steps × iterations). */
  readonly estimateNanoUsd: bigint;
  readonly deadlineSeconds: number;
  readonly concurrentRunCap: number;
  readonly budgets: readonly BudgetScope[];
  readonly now: Date;
}

export type AdmissionRefusalReason = 'insufficient-balance' | 'run-cap' | 'budget-exceeded';

/**
 * What the workflow engine's cost circuit consumes: the admitted estimate
 * and the named multiplier K — the run is killed when observed accrual
 * exceeds `hold × K` (limit precomputed here).
 */
export interface HoldReadout {
  readonly holdId: string;
  readonly walletId: string;
  readonly scopeIds: readonly string[];
  readonly estimateNanoUsd: bigint;
  readonly costCircuitMultiplier: bigint;
  readonly costCircuitLimitNanoUsd: bigint;
  readonly expiresAtMs: number;
}

export type AdmissionDecision =
  | { readonly admitted: true; readonly hold: HoldReadout }
  | { readonly admitted: false; readonly reason: AdmissionRefusalReason };

export interface AdmissionDeps {
  readonly redis: RedisClient;
  readonly db: Database;
  readonly stores: BillingStores;
}

function redisFailure(cause: unknown): DomainError {
  return unavailableError('admission refused: Redis unavailable (fail-closed)', cause);
}

function runAdmissionScript(
  deps: AdmissionDeps,
  request: AdmissionRequest,
  ttlSeconds: number
): ResultAsync<string, DomainError> {
  const keys = [
    BILLING_KEYS.walletSnapshot.buildKey(request.walletId),
    BILLING_KEYS.walletHolds.buildKey(request.walletId),
    ...request.budgets.map((budget) => BILLING_KEYS.scopeHolds.buildKey(budget.scopeId)),
  ];
  const args = [
    request.holdId,
    request.estimateNanoUsd.toString(10),
    String(request.now.getTime()),
    String(ttlSeconds),
    String(request.concurrentRunCap),
    ...request.budgets.map((budget) => budget.remainingNanoUsd.toString(10)),
  ];
  return fromPromise(
    deps.redis.createScript(ADMISSION_SCRIPT).exec(keys, args) as Promise<string>,
    redisFailure
  );
}

/**
 * DB-truth snapshot write-through: reads the wallet's committed balance and
 * CAS-writes it into the Redis snapshot. Two callers, one mechanism — the
 * admission bootstrap on a snapshot miss, and the post-settlement refresh
 * (best-effort, after the charge commits) that keeps the next admission from
 * gating on a stale balance until the snapshot TTL expires.
 */
export function refreshWalletSnapshot(
  deps: AdmissionDeps,
  walletId: string
): ResultAsync<void, DomainError> {
  return deps.stores.readWalletSnapshot(deps.db, walletId).andThen((snapshot) => {
    if (snapshot === null) {
      return errAsync(notFoundError('admission: wallet does not exist'));
    }
    return writeThroughSnapshot(deps.redis, {
      walletId,
      balanceNanoUsd: snapshot.balanceNanoUsd,
      ledgerSeq: snapshot.ledgerSeq,
      walletType: snapshot.type,
    }).map((): void => undefined);
  });
}

/** Estimates are positive by construction; a non-positive one is a caller bug. */
function assertAdmissible(request: AdmissionRequest): void {
  if (request.estimateNanoUsd <= 0n) {
    throw new RangeError('admitRun: estimate must be positive');
  }
  if (request.deadlineSeconds <= 0) {
    throw new RangeError('admitRun: deadline must be positive');
  }
}

export function admitRun(
  deps: AdmissionDeps,
  request: AdmissionRequest
): ResultAsync<AdmissionDecision, DomainError> {
  assertAdmissible(request);
  const ttlSeconds = request.deadlineSeconds + HOLD_TTL_MARGIN_SECONDS;
  if (ttlSeconds > MAX_HOLD_TTL_SECONDS) {
    return errAsync(
      validationError('admitRun: hold TTL would exceed the registry ceiling for holds hashes')
    );
  }
  const decide = (outcome: string): ResultAsync<AdmissionDecision, DomainError> => {
    if (outcome === 'admitted') {
      return okAsync({
        admitted: true,
        hold: {
          holdId: request.holdId,
          walletId: request.walletId,
          scopeIds: request.budgets.map((budget) => budget.scopeId),
          estimateNanoUsd: request.estimateNanoUsd,
          costCircuitMultiplier: COST_CIRCUIT_MULTIPLIER,
          costCircuitLimitNanoUsd: request.estimateNanoUsd * COST_CIRCUIT_MULTIPLIER,
          expiresAtMs: request.now.getTime() + ttlSeconds * 1000,
        },
      });
    }
    if (
      outcome === 'insufficient-balance' ||
      outcome === 'run-cap' ||
      outcome === 'budget-exceeded'
    ) {
      return okAsync({ admitted: false, reason: outcome });
    }
    return errAsync(unavailableError('admission script returned an unknown outcome'));
  };
  return runAdmissionScript(deps, request, ttlSeconds).andThen((outcome) => {
    if (outcome !== 'no-snapshot') return decide(outcome);
    return refreshWalletSnapshot(deps, request.walletId)
      .andThen(() => runAdmissionScript(deps, request, ttlSeconds))
      .andThen((retried) =>
        retried === 'no-snapshot'
          ? errAsync(unavailableError('admission snapshot bootstrap did not stick'))
          : decide(retried)
      );
  });
}

export interface ReleaseHoldArgs {
  readonly walletId: string;
  readonly holdId: string;
  readonly scopeIds: readonly string[];
}

/**
 * Early release at settlement — best-effort by design: a lost release just
 * leaves the hold to its TTL (the hold is not money).
 */
export function releaseHold(
  redis: RedisClient,
  args: ReleaseHoldArgs
): ResultAsync<void, DomainError> {
  return fromPromise(
    Promise.all([
      redis.hdel(BILLING_KEYS.walletHolds.buildKey(args.walletId), args.holdId),
      ...args.scopeIds.map((scopeId) =>
        redis.hdel(BILLING_KEYS.scopeHolds.buildKey(scopeId), args.holdId)
      ),
    ]),
    redisFailure
  ).map((): void => undefined);
}

export interface SnapshotWrite {
  readonly walletId: string;
  readonly balanceNanoUsd: bigint;
  readonly ledgerSeq: bigint;
  /**
   * Cached in the snapshot so the admission script can derive the balance
   * check from the wallet row's own type: only `free` wallets skip it.
   */
  readonly walletType: WalletType;
}

/**
 * Post-commit snapshot write-through, CASed on the wallet's ledger sequence.
 * Returns whether this write landed (false = a newer snapshot already
 * exists). Callers treat failures as best-effort: the snapshot TTL bounds
 * staleness and a miss re-reads Postgres.
 */
export function writeThroughSnapshot(
  redis: RedisClient,
  write: SnapshotWrite
): ResultAsync<boolean, DomainError> {
  const payload = JSON.stringify({
    balanceNanoUsd: write.balanceNanoUsd.toString(10),
    ledgerSeq: Number(write.ledgerSeq),
    type: write.walletType,
  });
  return fromPromise(
    redis
      .createScript(SNAPSHOT_CAS_SCRIPT)
      .exec(
        [BILLING_KEYS.walletSnapshot.buildKey(write.walletId)],
        [payload, String(write.ledgerSeq), String(BILLING_KEYS.walletSnapshot.ttlSeconds)]
      ) as Promise<number>,
    redisFailure
  ).map((written) => written === 1);
}
