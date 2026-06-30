export { callerUserId } from './principal.js';
export {
  USER_SEARCH_MAX_RESULTS,
  escapeLikePrefix,
  searchInvitableUsers,
  searchUsersQuerySchema,
} from './user-search.js';
export {
  MAX_ENCRYPTED_INSTRUCTIONS_BYTES,
  clearInstructions,
  getInstructions,
  putInstructionsBodySchema,
  saveInstructions,
} from './instructions.js';
export {
  getAccessibilityPreferences,
  putAccessibilityPreferencesBodySchema,
  saveAccessibilityPreferences,
} from './preferences.js';
export type { InvitableUser } from './user-search.js';
export type { InstructionsState } from './instructions.js';
export type { AccessibilityState, AccessibilityWriteOutcome } from './preferences.js';
export type { AccountStores, AccountStoresFactory } from '../ports/index.js';

// Routes may import only this barrel and the middleware (boundaries), so the
// lib surface the route seam needs — the uniform error body constructor and
// the idempotency wrappers the exemption declarations must compose with — is
// published here rather than imported from lib directly in routes.ts.
export { createErrorResponse } from '../../../lib/errors/index.js';
export { idempotencyExempt, idempotent, runMutation } from '../../../lib/idempotency/index.js';
export type { DomainError, DomainErrorCode } from '../../../lib/errors/index.js';
