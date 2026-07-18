import type { DomainError, DomainErrorOf } from '../../../lib/errors/index.js';

/**
 * The feedback-duplicate refusal: an identical body was submitted again within
 * the recent dedup window. It is a `conflict` in the DomainError taxonomy (so it
 * answers 409); the `feedbackDuplicate` marker lets the route answer with the
 * specific `FEEDBACK_DUPLICATE` wire code instead of the generic submit failure
 * — the same pattern the idempotency-conflict errors use for their wire codes.
 */
export interface FeedbackDuplicateError extends DomainErrorOf<'conflict'> {
  readonly feedbackDuplicate: true;
}

export function feedbackDuplicateError(): FeedbackDuplicateError {
  return {
    code: 'conflict',
    message: 'identical feedback body resubmitted within the dedup window',
    feedbackDuplicate: true,
  };
}

export function isFeedbackDuplicate(error: DomainError): error is FeedbackDuplicateError {
  return error.code === 'conflict' && 'feedbackDuplicate' in error;
}
