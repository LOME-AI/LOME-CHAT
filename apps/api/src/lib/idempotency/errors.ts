import { ERROR_CODES } from '@hushbox/shared';
import type { DomainErrorOf, DomainError } from '../errors/index.js';

type IdempotencyWireCode =
  | typeof ERROR_CODES.IDEMPOTENCY_BODY_MISMATCH
  | typeof ERROR_CODES.REQUEST_IN_PROGRESS;

/**
 * The two idempotency 409 classes. Both are `conflict` in the DomainError
 * taxonomy; the extra `wireCode` lets the route layer answer with the
 * specific API error code instead of the generic CONFLICT mapping.
 */
export interface IdempotencyConflictError extends DomainErrorOf<'conflict'> {
  readonly wireCode: IdempotencyWireCode;
}

/** Reused key + different canonical body — Stripe-style 409. */
export function bodyMismatchError(): IdempotencyConflictError {
  return {
    code: 'conflict',
    message: 'idempotency key reused with a different request body',
    wireCode: ERROR_CODES.IDEMPOTENCY_BODY_MISMATCH,
  };
}

/** A live `claimed` request-kind key — at most one execution in flight, ever. */
export function requestInProgressError(): IdempotencyConflictError {
  return {
    code: 'conflict',
    message: 'a request with this idempotency key is already in progress',
    wireCode: ERROR_CODES.REQUEST_IN_PROGRESS,
  };
}

const WIRE_CODES: ReadonlySet<string> = new Set([
  ERROR_CODES.IDEMPOTENCY_BODY_MISMATCH,
  ERROR_CODES.REQUEST_IN_PROGRESS,
]);

export function isIdempotencyConflict(error: DomainError): error is IdempotencyConflictError {
  return (
    error.code === 'conflict' &&
    'wireCode' in error &&
    typeof error.wireCode === 'string' &&
    WIRE_CODES.has(error.wireCode)
  );
}
