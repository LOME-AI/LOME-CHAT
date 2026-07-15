export { createIdentityManifest } from './routes.js';
export type { IdentityRouteDeps } from './routes.js';
export { createIdentityStores } from './adapters/stores.js';
// Per-IP abuse throttles for the unauthenticated auth surfaces, bound to the
// edge rate-limit enforcer at the composition root (routes may not import
// adapters). Paired with the per-user/email/token domain limiters.
export {
  loginIpRateLimit,
  recoveryGetKeyIpRateLimit,
  recoveryResetIpRateLimit,
  registerIpRateLimit,
  resendVerifyIpRateLimit,
  verifyEmailIpRateLimit,
} from './adapters/rate-limit.js';
export {
  SESSION_REVOKE_JOB_TYPE,
  SESSION_REVOKE_MAX_FAILURES,
  checkSessionLiveness,
  checkSessionRevocation,
  createSessionRevokeJobRegistration,
  evictUserBestEffort,
  issueBillingLoginToken,
  issueSession,
  resolveLinkGuestPrincipal,
  resolveTrialSessionPrincipal,
  revokeAllSessions,
} from './domain/index.js';
export type {
  SessionLivenessInputs,
  AccountDeletedEmailPort,
  AccountDeletionPurge,
  AccountLockedEmailPort,
  EvictUserPort,
  IdentityStores,
  IdentityStoresFactory,
  IdentityUsersStore,
  IssueSessionArgs,
  LinkCredentialResolution,
  LinkGuestPrincipal,
  LinkGuestResolution,
  LinkResolutionPort,
  LockUserOutcome,
  PasswordChangedEmailPort,
  SessionKind,
  SessionRevokeJobDeps,
  TrialSessionPrincipal,
  TwoFactorDisabledEmailPort,
  TwoFactorEnabledEmailPort,
  UnlockUserOutcome,
  UserLockReason,
  VerificationEmailPort,
} from './domain/index.js';
