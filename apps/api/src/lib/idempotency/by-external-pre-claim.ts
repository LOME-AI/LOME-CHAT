import { brandIdempotent } from './brands.js';
import type { ResultAsync } from '../result/index.js';
import type { Idempotent } from './brands.js';

export interface ByExternalPreClaimParams<C, X, T, E> {
  /**
   * The durable pre-claim (e.g. a `pending` payments row), committed BEFORE
   * the external effect — the record that reconciliation finds when the
   * process dies anywhere after the external call.
   */
  readonly preClaim: () => ResultAsync<C, E>;
  /** The external effect that must be captured exactly once. */
  readonly external: (claim: C) => ResultAsync<X, E>;
  /**
   * Finalizes the pre-claim with the external outcome. On a crash or error
   * here the pre-claim stays pending; the webhook or delayed verify job
   * resolves or expires it — never a second charge.
   */
  readonly finalize: (claim: C, external: X) => ResultAsync<T, E>;
}

/**
 * External-effect-then-reconcile (card charges): the wrapper enforces the
 * one ordering that makes the effect capturable exactly once — durable
 * pre-claim, then the external call, then finalize. Failures at any step
 * leave the pre-claim row as the reconciliation anchor.
 */
export function byExternalPreClaim<C, X, T, E>(
  params: ByExternalPreClaimParams<C, X, T, E>
): ResultAsync<Idempotent<T>, E> {
  return params
    .preClaim()
    .andThen((claim) =>
      params.external(claim).andThen((external) => params.finalize(claim, external))
    )
    .map((value) => brandIdempotent(value));
}
