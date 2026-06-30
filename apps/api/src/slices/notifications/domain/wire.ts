import { match } from 'ts-pattern';
import { DOMAIN_ERROR_CODE_TO_WIRE_CODE } from '@hushbox/shared';
import { createErrorResponse } from '../../../lib/errors/index.js';
import type { ErrorResponse } from '@hushbox/shared';
import type { DomainError } from '../../../lib/errors/index.js';

export type DomainErrorStatus = 400 | 401 | 403 | 404 | 409 | 429 | 503 | 504;

/** Route-level DomainError → HTTP status map (the lib leaves it to routes). */
export function domainErrorStatus(error: DomainError): DomainErrorStatus {
  return match(error.code)
    .with('validation', () => 400 as const)
    .with('unauthorized', () => 401 as const)
    .with('forbidden', () => 403 as const)
    .with('not_found', () => 404 as const)
    .with('conflict', () => 409 as const)
    .with('rate_limited', () => 429 as const)
    .with('timeout', () => 504 as const)
    .with('unavailable', () => 503 as const)
    .exhaustive();
}

/** The `{code}` wire body for an expected domain failure — never a message. */
export function domainErrorBody(error: DomainError): ErrorResponse {
  return createErrorResponse(DOMAIN_ERROR_CODE_TO_WIRE_CODE[error.code]);
}
