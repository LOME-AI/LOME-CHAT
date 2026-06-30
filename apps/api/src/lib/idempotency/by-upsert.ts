import { brandIdempotent } from './brands.js';
import type { ResultAsync } from '../result/index.js';
import type { Idempotent } from './brands.js';

/**
 * Natural-key creation: the operation must be a single
 * `INSERT … ON CONFLICT` statement whose unique constraint is the
 * idempotency guard — the database, not the caller, arbitrates duplicates,
 * so duplicate and racing deliveries converge on one row. The wrapper is the
 * typed seam that declares (and brands) that contract; raw mutations stay
 * inside repository modules.
 */
export function byUpsert<T, E>(upsert: () => ResultAsync<T, E>): ResultAsync<Idempotent<T>, E> {
  return upsert().map((value) => brandIdempotent(value));
}
