export { createNewsletterManifest } from './routes.js';
export type { NewsletterRouteDeps } from './routes.js';
export {
  createNewsletterStores,
  listSubscribersForAdmin,
  subscriberStats,
} from './adapters/stores.js';
export type {
  AdminSubscriberRow,
  AdminSubscribersPage,
  ListSubscribersForAdminParams,
  SubscriberStats,
} from './adapters/stores.js';
export {
  cancelIssueWithinTx,
  createIssueWithinTx,
  getIssueById,
  listIssues,
} from './adapters/issue-stores.js';
export type {
  CancelIssueResult,
  CreateIssueParams,
  ListIssuesPage,
  ListIssuesParams,
  NewsletterIssueRow,
} from './adapters/issue-stores.js';
export {
  NEWSLETTER_DISPATCH_JOB_TYPE,
  createNewsletterDispatchJobRegistration,
  enqueueIssueDispatch,
  newsletterDispatchPayloadSchema,
} from './domain/dispatch.js';
export type { NewsletterDispatchDeps } from './domain/dispatch.js';
export { createNewsletterDispatchStores } from './adapters/dispatch-stores.js';
export type { NewsletterDispatchStore } from './ports/index.js';
export { renderIssueEmail, sendIssueTest } from './domain/issue-email.js';
export type {
  IssueEmailUrls,
  RenderIssueEmailParams,
  RenderedIssueEmail,
  SendIssueTestParams,
} from './domain/issue-email.js';
export { createResendWebhookVerifier } from './domain/index.js';
export type {
  ResendWebhookEvent,
  ResendWebhookHeaders,
  ResendWebhookSecretEnv,
  ResendWebhookVerifier,
} from './domain/index.js';
export {
  newsletterConfirmIpRateLimit,
  newsletterSubscribeIpRateLimit,
  newsletterUnsubscribeIpRateLimit,
} from './adapters/rate-limit.js';
export type {
  AccountEmailReader,
  AccountEmailReaderFactory,
  NewsletterConfirmEmailPort,
  NewsletterStore,
  NewsletterStoresFactory,
} from './ports/index.js';
