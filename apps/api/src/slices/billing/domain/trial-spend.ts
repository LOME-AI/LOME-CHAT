import { secondsUntilNextUtcMidnight } from '@hushbox/shared';
import { unavailableError } from '../../../lib/errors/index.js';
import { errAsync, fromPromise, okAsync } from '../../../lib/result/index.js';
import { redisGet } from '../../../lib/redis/index.js';
import { TRIAL_SPEND_INCREMENT_SCRIPT } from './admission-scripts.js';
import { TRIAL_DAILY_SPEND_CAP_NANO_USD } from './constants.js';
import { BILLING_KEYS } from './keys.js';
import { utcDayKey } from './period.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { RedisClient } from './keys.js';

/**
 * The daily cumulative trial-spend counter — billing's single-writer gate on
 * aggregate free-trial provider spend. There is no wallet and no reservation:
 * ONE period-keyed Redis counter (`trial:global:spend:<UTC-day>`) holds the
 * day's actual provider cost, fed at settlement.
 *
 * Two operations, split by lifecycle:
 *  - {@link admitTrialSpend} reads the counter and compares it to the cap — a
 *    read-and-compare admission (a small burst can overshoot; that is bounded
 *    by the per-message cost, and adding a reservation is deliberately avoided).
 *  - {@link incrementTrialSpend} folds a settled run's actual cost into the
 *    counter and reports the one increment that crosses the cap.
 *
 * Both fail CLOSED: Redis unavailable ⇒ a typed `unavailable` error (the trial
 * hook maps admission to ADMISSION_UNAVAILABLE), never a silent admit.
 */

export interface TrialSpendDeps {
  readonly redis: RedisClient;
}

export interface TrialSpendReadRequest {
  readonly now: Date;
}

export interface TrialSpendAdmission {
  readonly admitted: boolean;
}

export interface TrialSpendIncrementRequest {
  /** The run's ACTUAL provider cost (Σ base cost) — never a JS number. */
  readonly amountNanoUsd: bigint;
  readonly now: Date;
}

export interface TrialSpendIncrement {
  /** True only for the single increment whose atomic post-value first reaches the cap. */
  readonly crossed: boolean;
  /** The day's cumulative total after this increment, as integer nano-USD. */
  readonly total: bigint;
}

/**
 * Read-and-compare admission: the counter below the cap admits, at or above it
 * refuses. A missing counter (no spend yet today) reads as zero and admits. A
 * corrupt (non-numeric or negative) counter fails validation and, via the
 * hook, fails closed — an ambiguous counter never over-admits.
 */
export function admitTrialSpend(
  deps: TrialSpendDeps,
  request: TrialSpendReadRequest
): ResultAsync<TrialSpendAdmission, DomainError> {
  return redisGet(deps.redis, BILLING_KEYS.trialDailySpend, utcDayKey(request.now)).map(
    (stored) => ({ admitted: (stored ?? 0n) < TRIAL_DAILY_SPEND_CAP_NANO_USD })
  );
}

/**
 * Fold `amountNanoUsd` into the day's counter (atomic INCRBY + midnight-anchored
 * NX expiry), returning whether this increment crossed the cap and the new
 * total. The amount crosses the process boundary as a decimal STRING so money
 * is never Number-coerced, and the total round-trips behind a non-numeric
 * status prefix so it is read back as a bigint, not a lossy JS number. The
 * key-day and the TTL both derive from `request.now`, so a mocked or skewed
 * clock stays internally consistent (never one clock for the key, another for
 * the expiry).
 */
export function incrementTrialSpend(
  deps: TrialSpendDeps,
  request: TrialSpendIncrementRequest
): ResultAsync<TrialSpendIncrement, DomainError> {
  const keys = [BILLING_KEYS.trialDailySpend.buildKey(utcDayKey(request.now))];
  const args = [
    request.amountNanoUsd.toString(10),
    TRIAL_DAILY_SPEND_CAP_NANO_USD.toString(10),
    String(secondsUntilNextUtcMidnight(request.now)),
  ];
  return fromPromise(
    deps.redis.createScript(TRIAL_SPEND_INCREMENT_SCRIPT).exec(keys, args) as Promise<string>,
    (cause) => unavailableError('trial spend increment failed', cause)
  ).andThen((outcome) => {
    const separator = outcome.indexOf(':');
    if (separator === -1) {
      return errAsync(unavailableError('trial spend increment returned unknown outcome'));
    }
    return okAsync({
      crossed: outcome.slice(0, separator) === 'crossed',
      total: BigInt(outcome.slice(separator + 1)),
    });
  });
}
