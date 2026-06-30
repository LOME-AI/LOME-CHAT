import type { DbTransaction } from './transaction.js';

/**
 * The idempotency type spine. Both brands are compile-time-only phantom
 * intersections; neither symbol has a runtime value, so the ONLY ways to
 * produce a branded value are the constructors below — and this module is
 * the single file where the brand casts are lint-legal (`as Idempotent` /
 * `as SettlementTx` fail lint everywhere else). Do not export the
 * constructors beyond the idempotency module's own wrappers.
 */

declare const IDEMPOTENT: unique symbol;

/**
 * A value produced through one of the five `idempotent.*` wrappers.
 * `runMutation` accepts only `Idempotent<T>`; the wrappers are the sole
 * producers.
 */
export type Idempotent<T> = T & { readonly [IDEMPOTENT]: 'Idempotent' };

declare const SETTLEMENT: unique symbol;

/**
 * The settlement transaction capability: every money `*WithinTx` write
 * requires it, and only the settlement entry point can mint it — consumers
 * receive the handle, never make it.
 */
export type SettlementTx = DbTransaction & { readonly [SETTLEMENT]: 'SettlementTx' };

/** Sole producer of `Idempotent<T>`; callable only inside the wrappers. */
export function brandIdempotent<T>(value: T): Idempotent<T> {
  return value as Idempotent<T>;
}

/** Sole producer of `SettlementTx`; callable only by the settlement entry point. */
export function brandSettlementTx(tx: DbTransaction): SettlementTx {
  return tx as SettlementTx;
}
