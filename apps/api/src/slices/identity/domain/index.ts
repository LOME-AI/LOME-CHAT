// The domain barrel carries exactly what its two consumers — routes.ts and
// the slice index — use. Domain-internal consumers import sibling modules
// directly; adding an export here means a route or the slice surface needs it.
export {
  createRegisterFinishFlow,
  registerFinishBodySchema,
  registerInitBodySchema,
  startRegistration,
} from './registration.js';
export {
  createLoginFinishFlow,
  loginFinishBodySchema,
  loginInitBodySchema,
  startLogin,
} from './login.js';
export { destroySessionCookie, issueSession, revokeSession } from './session.js';
export {
  billingTokenLogin,
  billingTokenLoginBodySchema,
  issueBillingLoginToken,
} from './billing-portal.js';
export { checkSessionRevocation } from './revocation.js';
export { resolveLinkGuestPrincipal } from './link-guest.js';
export type { LinkGuestPrincipal, LinkGuestResolution } from './link-guest.js';
export { resolveTrialSessionPrincipal } from './trial-session.js';
export type { ResolveTrialSessionArgs, TrialSessionPrincipal } from './trial-session.js';
export { duplicateFreshHandshakeDefect, requireOpaqueMasterSecret } from './opaque.js';
export {
  createTotpVerifySetupFlow,
  startTotpSetup,
  totpCodeBodySchema,
  verifyLogin2fa,
} from './totp.js';
export {
  changePasswordFinishBodySchema,
  changePasswordInitBodySchema,
  createPasswordChangeFinishFlow,
  startPasswordChange,
} from './password-change.js';
export {
  createDisable2faFinishFlow,
  disable2faFinishBodySchema,
  disable2faInitBodySchema,
  startDisable2fa,
} from './two-factor-disable.js';
export {
  createRecoveryResetFinishFlow,
  getRecoveryWrappedKey,
  recoveryGetKeyBodySchema,
  recoveryResetFinishBodySchema,
  recoveryResetInitBodySchema,
  startRecoveryReset,
} from './recovery.js';
export {
  resendVerification,
  resendVerificationBodySchema,
  verifyEmailBodySchema,
  verifyEmailToken,
} from './email-verification.js';
export {
  createDeleteAccountFinishFlow,
  deleteAccountFinishBodySchema,
  deleteAccountInitBodySchema,
  startDeleteAccount,
} from './deletion.js';
export type { RedisClient } from './keys.js';
export type { OpaqueFinishFlow } from './opaque.js';
export type { IssueSessionArgs, SessionKind } from './session.js';
export type {
  AccountLockedEmailPort,
  IdentityStores,
  IdentityStoresFactory,
  IdentityUserRecord,
  IdentityUsersStore,
  IdentityVerificationStore,
  LinkCredentialResolution,
  LinkResolutionPort,
  PasswordChangedEmailPort,
  TwoFactorDisabledEmailPort,
  TwoFactorEnabledEmailPort,
  VerificationEmailPort,
} from '../ports/index.js';

// Routes may import only this barrel and the middleware (boundaries), so the
// lib surface the route seam needs — the uniform error body constructor and
// the idempotency wrappers the exemption declarations must compose with — is
// published here rather than imported from lib directly in routes.ts.
export { createErrorResponse } from '../../../lib/errors/index.js';
export { idempotencyExempt, idempotent, runMutation } from '../../../lib/idempotency/index.js';
export { okAsync } from '../../../lib/result/index.js';
export type { ResultAsync } from '../../../lib/result/index.js';
export type { DomainError, DomainErrorCode } from '../../../lib/errors/index.js';

// Registration provisions the new user's wallets + welcome credit atomically
// with the account INSERT (§8 single-settlement), composing billing's
// published within-tx helper. Routes may import only this domain barrel, so
// the billing types the route deps name are re-exported through here.
export type { BillingStores, WelcomeEmailPort } from '../../billing/index.js';
