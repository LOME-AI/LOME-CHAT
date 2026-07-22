export { callerUserId } from './principal.js';
export { isFeedbackDuplicate } from './errors.js';
export { submitFeedback, submitFeedbackResponseSchema } from './submit.js';
export type { SubmitFeedbackResponse } from './submit.js';
export type { FeedbackStore, FeedbackStoresFactory, FeedbackSubmission } from '../ports/index.js';

// Routes may import only this barrel and the middleware (boundaries), so the
// lib surface the route seam needs — the uniform error body constructor and the
// idempotency machinery the byKey wrapper composes with — is published here
// rather than imported from lib directly in routes.ts.
export { createErrorResponse, domainWireCode } from '../../../lib/errors/index.js';
export {
  idempotent,
  isIdempotencyConflict,
  readIdempotencyKey,
  runMutation,
} from '../../../lib/idempotency/index.js';
export type { DomainError, DomainErrorCode } from '../../../lib/errors/index.js';
