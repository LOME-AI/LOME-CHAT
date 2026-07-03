export { createIdentityManifest } from './routes.js';
export type { IdentityRouteDeps } from './routes.js';
export { createIdentityStores } from './adapters/stores.js';
export {
  checkSessionRevocation,
  issueBillingLoginToken,
  issueSession,
  resolveLinkGuestPrincipal,
} from './domain/index.js';
export type {
  IdentityStores,
  IdentityStoresFactory,
  IssueSessionArgs,
  LinkCredentialResolution,
  LinkGuestPrincipal,
  LinkGuestResolution,
  LinkResolutionPort,
  PasswordChangedEmailPort,
  SessionKind,
  VerificationEmailPort,
} from './domain/index.js';
