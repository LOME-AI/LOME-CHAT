export { createIdentityManifest } from './routes.js';
export type { IdentityRouteDeps } from './routes.js';
export { createIdentityStores } from './adapters/stores.js';
export {
  checkSessionRevocation,
  issueBillingLoginToken,
  issueSession,
  resolveLinkGuestPrincipal,
  resolveTrialSessionPrincipal,
} from './domain/index.js';
export type {
  AccountLockedEmailPort,
  IdentityStores,
  IdentityStoresFactory,
  IssueSessionArgs,
  LinkCredentialResolution,
  LinkGuestPrincipal,
  LinkGuestResolution,
  LinkResolutionPort,
  PasswordChangedEmailPort,
  SessionKind,
  TrialSessionPrincipal,
  TwoFactorDisabledEmailPort,
  TwoFactorEnabledEmailPort,
  VerificationEmailPort,
} from './domain/index.js';
