import { brandIdempotent } from './brands.js';
import type { ResultAsync } from '../result/index.js';
import type { Idempotent } from './brands.js';

export interface ByEventIdParams<T, E> {
  /**
   * The atomic first-delivery claim on the provider's event id: a Postgres
   * unique insert for money events, always; Redis `SET NX` + TTL is
   * admissible only where losing the dedup record is tolerable (non-money).
   * Resolves true exactly once per event id.
   */
  readonly claim: () => ResultAsync<boolean, E>;
  /** Runs only for the delivery that won the claim. */
  readonly execute: () => ResultAsync<T, E>;
  /** The duplicate-delivery no-op outcome (e.g. re-read the prior result). */
  readonly onDuplicate: () => ResultAsync<T, E>;
}

/**
 * Webhook consumers and job handlers: the event id is claimed atomically,
 * so duplicate and racing deliveries execute the effect exactly once.
 */
export function byEventId<T, E>(params: ByEventIdParams<T, E>): ResultAsync<Idempotent<T>, E> {
  return params
    .claim()
    .andThen((claimed) => (claimed ? params.execute() : params.onDuplicate()))
    .map((value) => brandIdempotent(value));
}
