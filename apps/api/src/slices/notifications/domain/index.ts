export {
  registerDeviceToken,
  registerDeviceTokenSchema,
  registerWebSubscription,
  registerWebSubscriptionSchema,
  unregisterDeviceToken,
} from './device-tokens.js';
export type { RegisterDeviceTokenInput, RegisterWebSubscriptionInput } from './device-tokens.js';
export { fullSessionClaims } from './session-claims.js';
export { domainErrorBody, domainErrorStatus } from './wire.js';
export type { DomainErrorStatus } from './wire.js';
export { selectNotifyRecipients } from './notify-decision.js';
export type { SelectNotifyRecipientsParams } from './notify-decision.js';
export { isWithinQuietHours, localMinutesOfDay } from './quiet-hours.js';
export { notifyEvent } from './notify-event.js';
export type { NotifyEventDeps, NotifyEventInput } from './notify-event.js';
export {
  getNotificationPreferences,
  putNotificationPreferencesBodySchema,
  saveNotificationPreferences,
  toPreferencesView,
} from './notification-preferences.js';
export type { NotificationPreferencesView } from './notification-preferences.js';
export { defineEmailTemplate, escapeHtml } from './templates/builder.js';
export type { EmailContent } from './templates/builder.js';
export { verificationEmail } from './templates/verification.js';
export { newsletterConfirmationEmail } from './templates/newsletter-confirmation.js';
export { newsletterIssueEmail } from './templates/newsletter-issue.js';
export type { NewsletterIssueParams } from './templates/newsletter-issue.js';
export { welcomeEmail } from './templates/welcome.js';
export { passwordChangedEmail } from './templates/password-changed.js';
export { passwordResetEmail } from './templates/password-reset.js';
export { twoFactorEnabledEmail } from './templates/two-factor-enabled.js';
export { twoFactorDisabledEmail } from './templates/two-factor-disabled.js';
export { accountLockedEmail } from './templates/account-locked.js';
export { chargebackLockEmail } from './templates/chargeback-lock.js';
export { accountDeletedEmail } from './templates/account-deleted.js';
export {
  adminOpNotificationEmail,
  adminOpNotificationSubject,
} from './templates/admin-op-notification.js';
export { adminDailyDigestEmail, adminDailyDigestSubject } from './templates/admin-daily-digest.js';
export type { AdminDigestAction } from './templates/admin-daily-digest.js';

// Route-seam re-exports: routes.ts may import only this barrel and the
// middleware (boundaries), while the arch harness requires the idempotency
// wrapper call to stay lexically visible in the route registration — so the
// lib surface routes need travels through here.
export { idempotencyExempt, idempotent, runMutation } from '../../../lib/idempotency/index.js';
export { createErrorResponse } from '../../../lib/errors/index.js';
export type { DeviceTokenStore, NotificationPreferencesStore } from '../ports/index.js';
