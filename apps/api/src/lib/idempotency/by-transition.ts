import { okAsync } from '../result/index.js';
import { brandIdempotent } from './brands.js';
import type { ResultAsync } from '../result/index.js';
import type { Idempotent } from './brands.js';

export interface ByTransitionParams<T, E> {
  /**
   * One atomic conditional UPDATE (`… WHERE status = <expected>`), resolving
   * to the transitioned value, or `null` when 0 rows matched. Never
   * check-then-act — the WHERE clause is the check.
   */
  readonly transition: () => ResultAsync<T | null, E>;
  /**
   * The 0-row disambiguation: re-read the actual state and return the
   * already-terminal no-op value, an expected error — or throw for an
   * illegal state (a defect, never a Result).
   */
  readonly onZeroRows: () => ResultAsync<T, E>;
}

/**
 * State-machine steps: the conditional UPDATE either wins (exactly one
 * caller transitions) or matched nothing, and a 0-row outcome must be
 * disambiguated — already-done is a no-op, illegal state is a defect. The
 * wrapper makes skipping disambiguation impossible.
 */
export function byTransition<T, E>(
  params: ByTransitionParams<T, E>
): ResultAsync<Idempotent<T>, E> {
  return params
    .transition()
    .andThen((value) => (value === null ? params.onZeroRows() : okAsync<T, E>(value)))
    .map((value) => brandIdempotent(value));
}
