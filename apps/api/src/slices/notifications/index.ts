export { createNotificationsManifest } from './routes.js';
export type { NotificationsDeps } from './routes.js';
export {
  accountDeletedEmail,
  accountLockedEmail,
  adminDailyDigestEmail,
  adminDailyDigestSubject,
  adminOpNotificationEmail,
  adminOpNotificationSubject,
  chargebackLockEmail,
  newsletterConfirmationEmail,
  newsletterIssueEmail,
  passwordChangedEmail,
  passwordResetEmail,
  twoFactorDisabledEmail,
  twoFactorEnabledEmail,
  verificationEmail,
  welcomeEmail,
} from './domain/index.js';
export { notifyEvent } from './domain/index.js';
export type { NotifyEventDeps, NotifyEventInput } from './domain/index.js';
export {
  getNotificationPreferences,
  putNotificationPreferencesBodySchema,
  saveNotificationPreferences,
  toPreferencesView,
} from './domain/index.js';
export type { NotificationPreferencesView } from './domain/index.js';
export type { AdminDigestAction, EmailContent, NewsletterIssueParams } from './domain/index.js';
export { createDeviceTokenStore } from './adapters/device-token-store-db.js';
export { purgeStaleDeviceTokens } from './adapters/device-token-retention.js';
export { createNotificationPreferencesStore } from './adapters/notification-preferences-store-db.js';
export { createCompositePushSender } from './adapters/push-composite.js';
export type { CompositePushSenderDeps } from './adapters/push-composite.js';
export { createCollapseAliasDeriver } from './adapters/collapse-alias.js';
export { createMockEmailSender } from './adapters/email-mock.js';
export type { MockEmailSender, RecordedEmailBatch } from './adapters/email-mock.js';
export { createResendEmailSender } from './adapters/email-resend.js';
export type { ResendEmailSenderConfig } from './adapters/email-resend.js';
export {
  createEmailSenderFromEnv,
  findCapturedEmail,
  listCapturedEmails,
} from './adapters/email-sender-factory.js';
export type { CapturedEmail } from './adapters/email-sender-factory.js';
export { EMAIL_BATCH_MAX } from './ports/index.js';
export { createMockPushSender } from './adapters/push-mock.js';
export type { MockPushSender } from './adapters/push-mock.js';
// The raw FCM and Web Push transports are deliberately absent from this barrel:
// only the composite sender derives and stamps the per-conversation collapse
// alias and validates the wire payload, and a directly-bound transport skips
// both. `createPushSenderFromEnv` is the only construction site outside this
// slice. That narrows the public surface rather than closing the bypass — the
// composition root sits outside the boundaries lint's slice/lib/middleware
// globs, so a deep import of an adapter module there is not rejected.
export { createPushSenderFromEnv, listCapturedPushes } from './adapters/push-sender-factory.js';
export type {
  BatchEmailSender,
  BatchSendOptions,
  BatchSendResult,
  ConversationMemberView,
  DevicePlatform,
  DeviceTokenRegistration,
  DeviceTokenStore,
  EmailMessage,
  EmailSender,
  MembershipReader,
  NotificationPreferences,
  NotificationPreferencesStore,
  PushDelivery,
  PushDeviceRef,
  PushMessage,
  PushRecipient,
  PushSender,
} from './ports/index.js';
export { CATEGORY_TOGGLE, DEFAULT_NOTIFICATION_PREFERENCES } from './ports/index.js';
