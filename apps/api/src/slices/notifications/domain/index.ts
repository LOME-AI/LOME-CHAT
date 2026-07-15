export {
  registerDeviceToken,
  registerDeviceTokenSchema,
  unregisterDeviceToken,
} from './device-tokens.js';
export type { RegisterDeviceTokenInput } from './device-tokens.js';
export { fullSessionClaims } from './session-claims.js';
export { domainErrorBody, domainErrorStatus } from './wire.js';
export type { DomainErrorStatus } from './wire.js';
export { selectPushRecipients } from './push-recipients.js';
export type { SelectPushRecipientsParams } from './push-recipients.js';
export { sendPushForNewMessage } from './notify-message.js';
export type { MessagePushDeps, NewMessagePush } from './notify-message.js';
export { defineEmailTemplate, escapeHtml } from './templates/builder.js';
export type { EmailContent } from './templates/builder.js';
export { verificationEmail } from './templates/verification.js';
export { welcomeEmail } from './templates/welcome.js';
export { passwordChangedEmail } from './templates/password-changed.js';
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
export type { DeviceTokenStore } from '../ports/index.js';
