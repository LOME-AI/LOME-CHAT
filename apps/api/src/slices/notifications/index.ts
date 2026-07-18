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
  sendPushForNewMessage,
  twoFactorDisabledEmail,
  twoFactorEnabledEmail,
  verificationEmail,
  welcomeEmail,
} from './domain/index.js';
export type {
  AdminDigestAction,
  EmailContent,
  NewsletterIssueParams,
  MessagePushDeps,
  NewMessagePush,
} from './domain/index.js';
export { createDeviceTokenStore } from './adapters/device-token-store-db.js';
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
export { createFcmPushSender } from './adapters/push-fcm.js';
export type { FcmPushSenderConfig } from './adapters/push-fcm.js';
export { createPushSenderFromEnv } from './adapters/push-sender-factory.js';
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
  PresenceReader,
  PushDelivery,
  PushMessage,
  PushSender,
} from './ports/index.js';
