import { ResultAsync, err, fromPromise, ok, okAsync } from '../result/index.js';
import { brandIdempotent } from './brands.js';
import { hashCanonicalJson } from './canonical-json.js';
import { REQUEST_LEASE_SECONDS } from './config.js';
import { requestInProgressError } from './errors.js';
import { claimKeyRow, failKeyRow, succeedKeyRow } from './key-row.js';
import type { z } from 'zod';
import type { Database } from '@hushbox/db';
import type { DomainError } from '../errors/index.js';
import type { Result } from '../result/index.js';
import type { Idempotent } from './brands.js';
import type { IdempotencyScope, KeyRowClaim, KeyRowFence } from './key-row.js';
import type { DbTransaction } from './transaction.js';

export interface ByKeyParams<T> {
  readonly db: Database;
  /** `(userId, route, key)` — deliberately per-route (laxer than Stripe). */
  readonly scope: IdempotencyScope;
  /** The request body; canonicalized and hashed, so key reordering never 409s. */
  readonly body: unknown;
  /** The claimant identity recorded as `claimedBy` (the fence). */
  readonly executorId: string;
  readonly leaseSeconds?: number;
  /** Validates a replayed response; a stored response failing it is a defect. */
  readonly responseSchema: z.ZodType<T>;
  /**
   * The mutation. Runs inside ONE transaction together with the key row's
   * `claimed → succeeded` flip, so a crash at any moment commits either
   * everything or nothing; T must be JSON-serializable (it is the stored,
   * replayable response).
   */
  readonly execute: (tx: DbTransaction) => ResultAsync<T, DomainError>;
}

/** Carries an expected execution failure across the transaction boundary. */
class ExecuteFailed extends Error {
  constructor(readonly domainError: DomainError) {
    super('idempotency: execution failed');
  }
}

/** Aborts the transaction when the completion fence finds a zombie claimant. */
class FenceLost extends Error {
  constructor() {
    super('idempotency: completion fence lost');
  }
}

/**
 * Client-driven `Idempotency-Key` dedup for general mutating endpoints: the
 * unique insert is the claim; retries replay the stored response; a live
 * claim answers 409 in-progress; `failed` or a lease-expired claim permits
 * exactly one serialized re-execution.
 */
export function byKey<T>(params: ByKeyParams<T>): ResultAsync<Idempotent<T>, DomainError> {
  return fromPromise(hashCanonicalJson(params.body), defectRethrow)
    .andThen((bodyHash) =>
      claimKeyRow(params.db, {
        scope: params.scope,
        kind: 'request',
        bodyHash,
        executorId: params.executorId,
        leaseSeconds: params.leaseSeconds ?? REQUEST_LEASE_SECONDS,
      })
    )
    .andThen((claim) => continueFromClaim(params, claim));
}

/**
 * The post-claim continuation. Exported so the attach defect stays
 * executable in tests: `byKey` always claims kind=request and `claimKeyRow`
 * attaches only run-kind claims, so no store state can reach the attach arm
 * through `byKey` itself — it guards the contract against future
 * state-machine changes.
 */
export function continueFromClaim<T>(
  params: ByKeyParams<T>,
  claim: KeyRowClaim
): ResultAsync<Idempotent<T>, DomainError> {
  if (claim.outcome === 'replay') {
    // Replay is Postgres-authoritative by design. A Redis hot-path cache
    // tier can layer in front of this read once the typed Redis key
    // registry exists — only ever as a cache of the key row, never as a
    // second source of truth.
    return okAsync(brandIdempotent(params.responseSchema.parse(claim.response)));
  }
  if (claim.outcome === 'attach') {
    throw new Error('idempotency: attach outcome on a request-kind claim');
  }
  const fence: KeyRowFence = {
    id: claim.row.id,
    executorId: params.executorId,
    claims: claim.row.claims,
  };
  return execute(params, fence);
}

function execute<T>(
  params: ByKeyParams<T>,
  fence: KeyRowFence
): ResultAsync<Idempotent<T>, DomainError> {
  return new ResultAsync(runFenced(params, fence));
}

async function runFenced<T>(
  params: ByKeyParams<T>,
  fence: KeyRowFence
): Promise<Result<Idempotent<T>, DomainError>> {
  try {
    const value = await params.db.transaction(async (tx) => {
      const outcome = await params.execute(tx);
      if (outcome.isErr()) throw new ExecuteFailed(outcome.error);
      const flip = await succeedKeyRow(tx, fence, outcome.value);
      if (flip.isErr()) throw new ExecuteFailed(flip.error);
      if (flip.value === 'lost') throw new FenceLost();
      return outcome.value;
    });
    return ok(brandIdempotent(value));
  } catch (error) {
    // Drizzle has already rolled the transaction back: nothing committed.
    if (error instanceof FenceLost) return err(requestInProgressError());
    await markFailed(params.db, fence);
    if (error instanceof ExecuteFailed) return err(error.domainError);
    throw error;
  }
}

/**
 * Best-effort failed flip: if the fence write itself fails (or a zombie
 * lost it) the row stays as it is and lease expiry takes over — recovery is
 * in-mechanism, never a second delivery path.
 */
async function markFailed(db: Database, fence: KeyRowFence): Promise<void> {
  const flip = await failKeyRow(db, fence);
  flip.unwrapOr('lost');
}

/** Body canonicalization failures are caller defects — keep them throwing. */
function defectRethrow(cause: unknown): never {
  throw cause;
}
