import { ResultAsync } from 'neverthrow';
import type { DomainError } from '../errors/index.js';

/**
 * The convention seam for promise-based infrastructure: every rejection is
 * mapped into the DomainError taxonomy at the point of wrapping, so `unknown`
 * never travels in the Result error channel.
 */
export function fromPromise<T>(
  promise: PromiseLike<T>,
  mapError: (cause: unknown) => DomainError
): ResultAsync<T, DomainError> {
  return ResultAsync.fromPromise(promise, mapError);
}
