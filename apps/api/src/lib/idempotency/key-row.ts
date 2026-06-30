import { and, eq, or, sql } from 'drizzle-orm';
import { idempotencyKeys } from '@hushbox/db';
import { unavailableError } from '../errors/index.js';
import { errAsync, fromPromise, okAsync } from '../result/index.js';
import { bodyMismatchError, requestInProgressError } from './errors.js';
import type { Database } from '@hushbox/db';
import type { DomainError } from '../errors/index.js';
import type { ResultAsync } from '../result/index.js';
import type { DbWriter } from './transaction.js';

/**
 * The idempotency-key row state machine — the run referee and request dedup
 * in one table (`kind` splits the lifecycles). This module is the single
 * writer of `idempotency_keys`; everything else goes through these functions.
 *
 * States: first arrival INSERTs `claimed` (the unique constraint IS the
 * claim — race-free); `succeeded` replays the stored response; live
 * `claimed` answers in-progress (request) or attach (run); `failed` or a
 * lease-expired `claimed` row is reclaimed by one retry at a time via a CAS
 * on `claims`. Every completing write (succeed, fail, heartbeat) passes the
 * `claims`/`claimedBy` fence, so a zombie claimant can neither finish nor
 * keep a dead lease alive.
 *
 * All liveness math runs in SQL against the database clock — Postgres
 * timestamps are never compared to the process clock.
 */

export interface IdempotencyScope {
  readonly userId: string;
  /**
   * MUST be the matched route pattern (e.g. `/conversations/:id`), never the
   * concrete URL: concrete ids or query strings would fragment the dedup
   * scope per-target and can carry user-derived data into a plaintext column.
   */
  readonly route: string;
  readonly key: string;
}

export type IdempotencyKeyRow = typeof idempotencyKeys.$inferSelect;
export type KeyRowKind = IdempotencyKeyRow['kind'];

export interface ClaimKeyRowParams {
  readonly scope: IdempotencyScope;
  readonly kind: KeyRowKind;
  readonly bodyHash: string;
  readonly executorId: string;
  readonly leaseSeconds: number;
  /** Run-kind rows carry the run id that groups the run's charges. */
  readonly runId?: string;
}

export type KeyRowClaim =
  | { readonly outcome: 'executor'; readonly row: IdempotencyKeyRow }
  | { readonly outcome: 'replay'; readonly response: unknown }
  | { readonly outcome: 'attach'; readonly row: IdempotencyKeyRow };

/** The completion-fence identity every finishing write must present. */
export interface KeyRowFence {
  readonly id: string;
  readonly executorId: string;
  readonly claims: number;
}

/** A programming error in the caller (e.g. kind contradiction) — never a Result. */
class KeyRowDefect extends Error {}

function infraError(cause: unknown): DomainError {
  // Defects must keep throwing (doctrine: exceptions are defects). Throwing
  // from the mapper rejects the underlying promise, so awaiting the
  // ResultAsync rethrows instead of yielding an err().
  if (cause instanceof KeyRowDefect) throw cause;
  return unavailableError('idempotency key store unavailable', cause);
}

export function claimKeyRow(
  db: Database,
  params: ClaimKeyRowParams
): ResultAsync<KeyRowClaim, DomainError> {
  return fromPromise(resolveClaim(db, params), infraError).andThen((claim) =>
    claim instanceof ClaimConflict ? errAsync(claim.error) : okAsync(claim)
  );
}

/** Internal carrier so expected conflicts survive the fromPromise seam. */
class ClaimConflict {
  constructor(readonly error: DomainError) {}
}

async function resolveClaim(
  db: Database,
  params: ClaimKeyRowParams
): Promise<KeyRowClaim | ClaimConflict> {
  // Purge-race tolerance: a conflicting row that vanishes between the insert
  // and the read gets one fresh insert attempt before giving up.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const inserted = await insertClaim(db, params);
    if (inserted !== undefined) return { outcome: 'executor', row: inserted };
    const resolved = await resolveConflict(db, params);
    if (resolved !== undefined) return resolved;
  }
  return new ClaimConflict(
    infraError(new Error('idempotency: claim insert kept conflicting with a vanishing row'))
  );
}

async function resolveConflict(
  db: Database,
  params: ClaimKeyRowParams
): Promise<KeyRowClaim | ClaimConflict | undefined> {
  const existing = await readScope(db, params.scope);
  if (existing === undefined) return undefined;
  if (existing.kind !== params.kind) {
    // Identified by row id + route only: the key is client-chosen and can
    // carry user-derived data (codes-never-content doctrine).
    throw new KeyRowDefect(
      `idempotency: key row ${existing.id} (route ${params.scope.route}) holds kind=${existing.kind}, claimed as kind=${params.kind}`
    );
  }
  if (existing.bodyHash !== params.bodyHash) return new ClaimConflict(bodyMismatchError());
  if (existing.status === 'succeeded') {
    return { outcome: 'replay', response: existing.response };
  }
  const reclaimed = await reclaim(db, params, existing);
  if (reclaimed !== undefined) return { outcome: 'executor', row: reclaimed };
  return disambiguateLiveClaim(db, params);
}

/** Lost the reclaim race or the claim is live: one re-read disambiguates. */
async function disambiguateLiveClaim(
  db: Database,
  params: ClaimKeyRowParams
): Promise<KeyRowClaim | ClaimConflict | undefined> {
  const settled = await readScope(db, params.scope);
  if (settled === undefined) return undefined;
  if (settled.status === 'succeeded') {
    return { outcome: 'replay', response: settled.response };
  }
  if (settled.status === 'claimed' && params.kind === 'run') {
    return { outcome: 'attach', row: settled };
  }
  return new ClaimConflict(requestInProgressError());
}

async function insertClaim(
  db: Database,
  params: ClaimKeyRowParams
): Promise<IdempotencyKeyRow | undefined> {
  const rows = await db
    .insert(idempotencyKeys)
    .values({
      userId: params.scope.userId,
      route: params.scope.route,
      key: params.scope.key,
      kind: params.kind,
      bodyHash: params.bodyHash,
      claimedBy: params.executorId,
      runId: params.runId ?? null,
    })
    .onConflictDoNothing({
      target: [idempotencyKeys.userId, idempotencyKeys.route, idempotencyKeys.key],
    })
    .returning();
  return rows[0];
}

async function readScope(
  db: Database,
  scope: IdempotencyScope
): Promise<IdempotencyKeyRow | undefined> {
  const rows = await db
    .select()
    .from(idempotencyKeys)
    .where(
      and(
        eq(idempotencyKeys.userId, scope.userId),
        eq(idempotencyKeys.route, scope.route),
        eq(idempotencyKeys.key, scope.key)
      )
    );
  return rows[0];
}

/**
 * The serialized re-execution gate: one atomic CAS on `claims` reclaims a
 * `failed` row or a `claimed` row whose lease expired — at most one retry
 * wins; a live lease never matches.
 */
async function reclaim(
  db: Database,
  params: ClaimKeyRowParams,
  observed: IdempotencyKeyRow
): Promise<IdempotencyKeyRow | undefined> {
  const rows = await db
    .update(idempotencyKeys)
    .set({
      status: 'claimed',
      claims: sql`${idempotencyKeys.claims} + 1`,
      claimedBy: params.executorId,
      claimedAt: sql`now()`,
      completedAt: null,
      ...(params.runId === undefined ? {} : { runId: params.runId }),
    })
    .where(
      and(
        eq(idempotencyKeys.id, observed.id),
        eq(idempotencyKeys.claims, observed.claims),
        or(
          eq(idempotencyKeys.status, 'failed'),
          and(
            eq(idempotencyKeys.status, 'claimed'),
            sql`${idempotencyKeys.claimedAt} + make_interval(secs => ${params.leaseSeconds}) <= now()`
          )
        )
      )
    )
    .returning();
  return rows[0];
}

function fenceCondition(fence: KeyRowFence): ReturnType<typeof and> {
  return and(
    eq(idempotencyKeys.id, fence.id),
    eq(idempotencyKeys.status, 'claimed'),
    eq(idempotencyKeys.claimedBy, fence.executorId),
    eq(idempotencyKeys.claims, fence.claims)
  );
}

/**
 * Fenced terminal flip to `succeeded`, storing the replayable response.
 * Accepts an open transaction so the flip can commit atomically with the
 * mutation's own effects; `lost` means a zombie claimant tried to finish.
 */
export function succeedKeyRow(
  writer: DbWriter,
  fence: KeyRowFence,
  response: unknown
): ResultAsync<'flipped' | 'lost', DomainError> {
  return fromPromise(
    writer
      .update(idempotencyKeys)
      .set({ status: 'succeeded', response, completedAt: sql`now()` })
      .where(fenceCondition(fence))
      .returning({ id: idempotencyKeys.id }),
    infraError
  ).map((rows) => (rows.length === 1 ? 'flipped' : 'lost'));
}

/** Fenced terminal flip to `failed` — permits one serialized re-execution. */
export function failKeyRow(
  writer: DbWriter,
  fence: KeyRowFence
): ResultAsync<'flipped' | 'lost', DomainError> {
  return fromPromise(
    writer
      .update(idempotencyKeys)
      .set({ status: 'failed', completedAt: sql`now()` })
      .where(fenceCondition(fence))
      .returning({ id: idempotencyKeys.id }),
    infraError
  ).map((rows) => (rows.length === 1 ? 'flipped' : 'lost'));
}

/**
 * Fenced lease touch: the live executor refreshes `claimedAt` on a short
 * interval so the lease stays short. A zombie's heartbeat matches zero rows
 * — it can never keep a dead lease alive.
 */
export function heartbeatKeyRow(
  db: Database,
  fence: KeyRowFence
): ResultAsync<'alive' | 'lost', DomainError> {
  return fromPromise(
    db
      .update(idempotencyKeys)
      .set({ claimedAt: sql`now()` })
      .where(fenceCondition(fence))
      .returning({ id: idempotencyKeys.id }),
    infraError
  ).map((rows) => (rows.length === 1 ? 'alive' : 'lost'));
}
