import { bannerSet } from './banner.js';
import { feedbackSetStatus } from './feedback.js';
import { jobDiscard, jobRedrive, jobRestore } from './job.js';
import { modelDisable, modelEnable } from './model.js';
import { newsletterCancel, newsletterSchedule, newsletterTestSend } from './newsletter.js';
import { shareRevoke, shareUnrevoke } from './share.js';
import { sessionsRevokeAll, userLock, userUnlock } from './user.js';
import { walletClawback, walletCredit } from './wallet.js';
import type { AdminOpImplementation } from '../registry.js';
import type { AdminBannerDeps } from './banner.js';
import type { AdminFeedbackDeps } from './feedback.js';
import type { AdminJobDeps } from './job.js';
import type { AdminModelDeps } from './model.js';
import type { AdminNewsletterDeps } from './newsletter.js';
import type { AdminShareDeps } from './share.js';
import type { AdminUserDeps } from './user.js';
import type { AdminWalletDeps } from './wallet.js';

/**
 * The v1 admin op implementations, grouped per composed-slice dependency
 * set and combined into one list so every registry construction over it
 * passes the Iron Law gate (a durable mutation without its registered
 * inverse fails `createAdminOpRegistry` at boot).
 */
export const adminWalletOperations: readonly AdminOpImplementation<AdminWalletDeps>[] = [
  walletCredit,
  walletClawback,
];

export const adminUserOperations: readonly AdminOpImplementation<AdminUserDeps>[] = [
  userLock,
  userUnlock,
  sessionsRevokeAll,
];

export const adminJobOperations: readonly AdminOpImplementation<AdminJobDeps>[] = [
  jobRedrive,
  jobDiscard,
  jobRestore,
];

export const adminModelOperations: readonly AdminOpImplementation<AdminModelDeps>[] = [
  modelDisable,
  modelEnable,
];

export const adminShareOperations: readonly AdminOpImplementation<AdminShareDeps>[] = [
  shareRevoke,
  shareUnrevoke,
];

export const adminFeedbackOperations: readonly AdminOpImplementation<AdminFeedbackDeps>[] = [
  feedbackSetStatus,
];

export const adminBannerOperations: readonly AdminOpImplementation<AdminBannerDeps>[] = [bannerSet];

export const adminNewsletterOperations: readonly AdminOpImplementation<AdminNewsletterDeps>[] = [
  newsletterSchedule,
  newsletterCancel,
  newsletterTestSend,
];

/**
 * The full production op set's dependency union (`AdminOpEngineDeps.opDeps`).
 * `feedback.setStatus` contributes nothing — it composes only the engine-owned
 * `SettlementTx` — so `AdminFeedbackDeps` (empty) is deliberately not part of
 * the union.
 */
export interface AdminOperationsDeps
  extends
    AdminWalletDeps,
    AdminUserDeps,
    AdminJobDeps,
    AdminModelDeps,
    AdminShareDeps,
    AdminBannerDeps,
    AdminNewsletterDeps {}

export const adminOperations: readonly AdminOpImplementation<AdminOperationsDeps>[] = [
  ...adminWalletOperations,
  ...adminUserOperations,
  ...adminJobOperations,
  ...adminModelOperations,
  ...adminShareOperations,
  ...adminFeedbackOperations,
  ...adminBannerOperations,
  ...adminNewsletterOperations,
];

export type { AdminBannerDeps } from './banner.js';
export type { AdminFeedbackDeps } from './feedback.js';
export type { AdminJobDeps } from './job.js';
export type { AdminModelDeps } from './model.js';
export type { AdminNewsletterDeps } from './newsletter.js';
export type { AdminShareDeps } from './share.js';
export type { AdminOpsClock, AdminUserDeps } from './user.js';
export type { AdminWalletDeps, WalletSnapshotRedis } from './wallet.js';
