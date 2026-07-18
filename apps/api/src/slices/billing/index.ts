export { createWebhookVerifier } from './domain/index.js';
export type {
  PaymentWebhookEvent,
  WebhookSignatureHeaders,
  WebhookVerifier,
  WebhookVerifierConfig,
} from './domain/index.js';
export { createHelcimPaymentProvider } from './adapters/payment-helcim.js';
export { createMockPaymentProvider } from './adapters/payment-mock.js';
export { createPaymentProviderFromEnv } from './adapters/payment-provider-factory.js';
export type {
  HelcimNetworkOptions,
  HelcimPaymentProviderConfig,
} from './adapters/payment-helcim.js';
export type { MockPaymentProvider, MockPaymentProviderConfig } from './adapters/payment-mock.js';
export type { PaymentProviderFactoryOptions } from './adapters/payment-provider-factory.js';
export type {
  CaptureLookup,
  CaptureRecord,
  ChargeOutcome,
  ChargeRequest,
  ChargeStatus,
  PaymentProvider,
} from './ports/index.js';

export { createBillingManifest } from './routes.js';
export type { BillingRouteDeps } from './routes.js';
export { createBillingStores } from './adapters/stores.js';
export {
  CARD_DECLINED_ERROR_CODE,
  COST_CIRCUIT_MULTIPLIER,
  DAILY_ALLOWANCE_NANO_USD,
  PAYMENT_MINIMUM_NANO_USD,
  PAYMENT_VERIFY_DELAY_SECONDS,
  PAYMENT_VERIFY_JOB_TYPE,
  PAYMENT_VERIFY_MAX_FAILURES,
  PENDING_RECONCILE_AGE_SECONDS,
  TRIAL_DAILY_SPEND_CAP_NANO_USD,
  WELCOME_CREDIT_NANO_USD,
  admitRun,
  admitTrialSpend,
  applyMarkup,
  applyPaymentWebhookEvent,
  chargeWithinTx,
  compareSnapshotToLedger,
  createPaymentVerifyJobRegistration,
  enqueuePaymentVerifyWithinTx,
  listSnapshotWalletIds,
  groupEffectiveRemainingNanoUsd,
  incrementTrialSpend,
  initiateCardPayment,
  initiatePaymentBodySchema,
  MEDIA_STORAGE_COST_PER_BYTE_NANO,
  STORAGE_COST_PER_CHARACTER_NANO,
  paymentReference,
  provisionUserBilling,
  provisionWalletsWithinTx,
  readBalance,
  refreshWalletSnapshot,
  readUsageBreakdown,
  releaseHold,
  resolveBudgetScopes,
  runConservationAudit,
  runPendingPaymentReconciliation,
  usdToNanoUsd,
  writeThroughSnapshot,
} from './domain/index.js';
export type {
  AdmissionDecision,
  AdmissionDeps,
  AdmissionRefusalReason,
  AdmissionRequest,
  BalanceView,
  BudgetResolutionRequest,
  BudgetScope,
  CardPaymentOutcome,
  ChargeInput,
  ChargeResult,
  ConservationAuditFindings,
  ConversationBudgetScopeRequest,
  HoldReadout,
  InitiateCardPaymentArgs,
  InitiateCardPaymentDeps,
  MemberBudgetScopeRequest,
  PaymentVerifyDeps,
  PaymentWebhookApplication,
  PaymentWebhookDeps,
  PaymentWebhookDisposition,
  PendingReconciliationFindings,
  ProvisionResult,
  ProvisionUserBillingArgs,
  ProvisionUserBillingDeps,
  ReleaseHoldArgs,
  SnapshotWrite,
  TrialSpendDeps,
  UsageBreakdownResult,
  WalletSnapshotComparison,
} from './domain/index.js';
export type {
  AccountDefensePort,
  ChargebackLockEmailPort,
  BillingStores,
  LedgerLegInput,
  PaymentRecord,
  PaymentStatus,
  SpendingUpsert,
  StalePendingPayment,
  UsageRecordInput,
  UsageRecordRow,
  WalletRecord,
  WelcomeEmailPort,
} from './ports/index.js';
// ports/index.ts is frozen for this task; these two live in ports/stores.ts.
export type { UsageBreakdownQuery, UsageBreakdownRow } from './ports/stores.js';

// The anonymized public usage-stats surface (the snapshot cron and the
// public endpoint compose these; raw counts never cross this barrel).
export { createPublicStatsStores } from './adapters/public-stats-stores.js';
export {
  buildPublicUsageStats,
  readLatestPublicStatsSnapshot,
  savePublicStatsSnapshot,
} from './domain/index.js';
export type { BuildPublicUsageStatsDeps, PublicStatsModelMeta } from './domain/index.js';
export type {
  GlobalUsageWindowQuery,
  PublicStatsSnapshotRow,
  PublicStatsStores,
} from './ports/public-stats.js';
