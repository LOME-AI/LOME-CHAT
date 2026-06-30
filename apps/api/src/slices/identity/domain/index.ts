export { consumeRateLimit, evaluateWindow } from './rate-limit.js';
export {
  deserializeExpectedAuthResult,
  deserializeKe1,
  deserializeKe3,
  deserializeRegistrationRecord,
  deserializeRegistrationRequest,
  requireOpaqueMasterSecret,
} from './opaque.js';
export {
  completeRegistration,
  consumePendingRegistration,
  registerFinishBodySchema,
  registerInitBodySchema,
  startRegistration,
} from './registration.js';
export {
  canonicalIdentifier,
  finishLogin,
  loginFinishBodySchema,
  loginInitBodySchema,
  startLogin,
} from './login.js';
export {
  PENDING_2FA_TTL_MS,
  destroySessionCookie,
  issueSession,
  revokeSession,
} from './session.js';
export { checkSessionRevocation } from './revocation.js';
export type { RateLimitDecision, WindowEvaluation } from './rate-limit.js';
export type {
  CompleteRegistrationArgs,
  ConsumePendingRegistrationOutcome,
  RegistrationStartArgs,
  RegistrationStartOutcome,
} from './registration.js';
export type {
  LoginFinishArgs,
  LoginFinishOutcome,
  LoginStartArgs,
  LoginStartOutcome,
} from './login.js';
export type { IssueSessionArgs, SessionKind } from './session.js';
export type {
  IdentityStores,
  IdentityStoresFactory,
  IdentityUserRecord,
  IdentityUsersStore,
  InsertRegisteredOutcome,
  RegistrationValues,
} from '../ports/index.js';

// Routes may import only this barrel and the middleware (boundaries), so the
// lib surface the route seam needs — the uniform error body constructor and
// the idempotency wrappers the exemption declarations must compose with — is
// published here rather than imported from lib directly in routes.ts.
export { createErrorResponse } from '../../../lib/errors/index.js';
export { idempotencyExempt, idempotent, runMutation } from '../../../lib/idempotency/index.js';
export type { DomainError, DomainErrorCode } from '../../../lib/errors/index.js';
