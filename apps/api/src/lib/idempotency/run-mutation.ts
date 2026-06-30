import type { ResultAsync } from '../result/index.js';
import type { Idempotent } from './brands.js';

/**
 * The route helper every mutating handler funnels through. Its whole value
 * is the parameter type: only `Idempotent<T>` is accepted, and only the
 * `idempotent.*` wrappers produce it — an unclassified mutation cannot
 * compile its way into a route.
 */
export function runMutation<T, E>(
  mutation: () => ResultAsync<Idempotent<T>, E>
): ResultAsync<Idempotent<T>, E> {
  return mutation();
}
