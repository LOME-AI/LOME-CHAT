import { unavailableError } from '../../../lib/errors/index.js';
import { errAsync, fromPromise, okAsync } from '../../../lib/result/index.js';
import { SCOPE_ADMISSION_SCRIPT } from './admission-scripts.js';
import { HOLD_TTL_MARGIN_SECONDS } from './constants.js';
import { BILLING_KEYS } from './keys.js';
import { utcDayKey } from './period.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { RedisClient } from './keys.js';

/**
 * Scope-only admission — the billing-published gate the trial policy hook
 * composes. {@link admitRun} cannot serve it: paid admission requires a wallet
 * snapshot (balance, run-cap), and a trial run has no wallet. This reserves a
 * run's estimate against ONE period-keyed scope holds hash and refuses once
 * the active holds would exceed the supplied budget — bounding aggregate
 * concurrent trial provider exposure with no wallet leg.
 *
 * Like paid admission it fails CLOSED: Redis down ⇒ a typed `unavailable`
 * error (the engine maps it to ADMISSION_UNAVAILABLE), never a silent admit.
 */

export interface ScopeAdmissionRequest {
  /** The period-keyed scope holds hash to reserve against (e.g. `trialGlobalScopeId`). */
  readonly scopeId: string;
  /** This run's hold id — the fence field under which the reservation is stored. */
  readonly holdId: string;
  /** The run's worst-case estimate to reserve. */
  readonly estimateNanoUsd: bigint;
  /** The scope's ceiling; the hold is refused when active holds + estimate would exceed it. */
  readonly remainingNanoUsd: bigint;
  /** The run deadline; the hold outlives it by `HOLD_TTL_MARGIN_SECONDS` (same as `admitRun`). */
  readonly deadlineSeconds: number;
  readonly now: Date;
}

export type ScopeAdmissionDecision =
  | { readonly admitted: true; readonly holdId: string }
  | { readonly admitted: false };

export interface ScopeAdmissionDeps {
  readonly redis: RedisClient;
}

function redisFailure(cause: unknown): DomainError {
  return unavailableError('scope admission refused: Redis unavailable (fail-closed)', cause);
}

export function admitScope(
  deps: ScopeAdmissionDeps,
  request: ScopeAdmissionRequest
): ResultAsync<ScopeAdmissionDecision, DomainError> {
  const keys = [BILLING_KEYS.scopeHolds.buildKey(request.scopeId)];
  const args = [
    request.holdId,
    request.estimateNanoUsd.toString(10),
    String(request.now.getTime()),
    String(request.deadlineSeconds + HOLD_TTL_MARGIN_SECONDS),
    request.remainingNanoUsd.toString(10),
  ];
  return fromPromise(
    deps.redis.createScript(SCOPE_ADMISSION_SCRIPT).exec(keys, args) as Promise<string>,
    redisFailure
  ).andThen((outcome) => {
    if (outcome === 'admitted') return okAsync({ admitted: true as const, holdId: request.holdId });
    if (outcome === 'budget-exceeded') return okAsync({ admitted: false as const });
    return errAsync(unavailableError('scope admission script returned unknown outcome'));
  });
}

/**
 * The global trial/welcome Sybil scope id: `trial:global:<UTC-day>`. Day-keyed
 * so the key name rolls over cleanly with the day; the reservations inside it
 * are minute-scale (they expire with each run), so the scope only ever reflects
 * concurrent exposure. Every trial run reserves against this one scope, so the
 * budget is a global ceiling shared across all trial sessions.
 */
export function trialGlobalScopeId(now: Date): string {
  return `trial:global:${utcDayKey(now)}`;
}
