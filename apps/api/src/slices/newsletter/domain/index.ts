export { confirmNewsletterSubscription } from './confirm.js';
export type { ConfirmOutcome } from './confirm.js';
export { callerUserId } from './principal.js';
export { readNewsletterSettings, writeNewsletterSettings } from './settings.js';
export type { NewsletterSettings } from './settings.js';
export { NEWSLETTER_RESEND_THROTTLE_MS, subscribeToNewsletter } from './subscribe.js';
export { suppressRecipients } from './suppress.js';
export { unsubscribeFromNewsletter } from './unsubscribe.js';
export { createResendWebhookVerifier } from './webhook-verify.js';
export type {
  ResendWebhookEvent,
  ResendWebhookHeaders,
  ResendWebhookSecretEnv,
  ResendWebhookVerifier,
} from './webhook-verify.js';
export type { UnsubscribeOutcome } from './unsubscribe.js';
export type {
  AccountEmailReader,
  AccountEmailReaderFactory,
  ConfirmTokenIssue,
  NewsletterConfirmEmailPort,
  NewsletterConsent,
  NewsletterStore,
  NewsletterStoresFactory,
  NewsletterSubscriberSnapshot,
} from '../ports/index.js';

// Routes import only this barrel + middleware (boundaries), so the lib
// surface the route seam needs — the uniform error-body constructor and the
// idempotency machinery the wrappers compose — is published here rather than
// imported from lib directly in routes.ts.
export { createErrorResponse, domainWireCode } from '../../../lib/errors/index.js';
export { idempotencyExempt, idempotent, runMutation } from '../../../lib/idempotency/index.js';
export { okAsync } from '../../../lib/result/index.js';
export type { DomainError, DomainErrorCode } from '../../../lib/errors/index.js';
