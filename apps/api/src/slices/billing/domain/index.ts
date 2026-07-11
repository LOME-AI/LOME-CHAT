export { createWebhookVerifier } from './webhook-verify.js';
export type {
  PaymentWebhookEvent,
  WebhookSignatureHeaders,
  WebhookVerifier,
  WebhookVerifierConfig,
} from './webhook-verify.js';

export {
  COST_CIRCUIT_MULTIPLIER,
  DAILY_ALLOWANCE_NANO_USD,
  SNAPSHOT_TTL_SECONDS,
  TRIAL_DAILY_SPEND_CAP_NANO_USD,
  WELCOME_CREDIT_NANO_USD,
} from './constants.js';
export {
  MARKUP_BASIS_POINTS,
  MEDIA_STORAGE_COST_PER_BYTE_NANO,
  STORAGE_COST_PER_CHARACTER_NANO,
  applyMarkup,
  roundHalfEvenDiv,
  usdToNanoUsd,
} from './money.js';
export { utcDayKey } from './period.js';
export { BILLING_KEYS, holdFieldSchema, walletSnapshotSchema } from './keys.js';
export type { RedisClient } from './keys.js';
export { provisionUserBilling, provisionWalletsWithinTx } from './wallets.js';
export type {
  ProvisionResult,
  ProvisionUserBillingArgs,
  ProvisionUserBillingDeps,
} from './wallets.js';
export { chargeWithinTx } from './charge.js';
export type { ChargeInput, ChargeResult } from './charge.js';
export { admitRun, refreshWalletSnapshot, releaseHold, writeThroughSnapshot } from './admission.js';
export type {
  AdmissionDecision,
  AdmissionDeps,
  AdmissionRefusalReason,
  AdmissionRequest,
  BudgetScope,
  HoldReadout,
  ReleaseHoldArgs,
  SnapshotWrite,
} from './admission.js';
export { admitTrialSpend, incrementTrialSpend } from './trial-spend.js';
export type { TrialSpendDeps } from './trial-spend.js';
export {
  CARD_DECLINED_ERROR_CODE,
  NANO_USD_PER_CENT,
  PAYMENT_MINIMUM_NANO_USD,
  PAYMENT_VERIFY_DELAY_SECONDS,
  PAYMENT_VERIFY_JOB_TYPE,
  cardPaymentOutcomeOf,
  creditPaymentWithinTx,
  enqueuePaymentVerifyWithinTx,
  initiateCardPayment,
  initiatePaymentBodySchema,
  payerUserId,
  paymentReference,
} from './payments.js';
export type {
  CardPaymentOutcome,
  CreditPaymentArgs,
  InitiateCardPaymentArgs,
  InitiateCardPaymentDeps,
} from './payments.js';
export {
  PAYMENT_VERIFY_MAX_FAILURES,
  createPaymentVerifyJobRegistration,
} from './payment-verify.js';
export type { PaymentVerifyDeps } from './payment-verify.js';
export {
  CHARGEBACK_REVOKE_JOB_TYPE,
  applyPaymentWebhookEvent,
  recordPaymentWebhookEvidence,
} from './payment-webhook.js';
export type {
  PaymentWebhookApplication,
  PaymentWebhookDeps,
  PaymentWebhookDisposition,
} from './payment-webhook.js';
export {
  compareSnapshotToLedger,
  listSnapshotWalletIds,
  runConservationAudit,
} from './auditors.js';
export type {
  ConservationAuditFindings,
  SnapshotDriftDeps,
  WalletSnapshotComparison,
} from './auditors.js';
export {
  PENDING_RECONCILE_AGE_SECONDS,
  runPendingPaymentReconciliation,
} from './reconciliation.js';
export type { PendingReconciliationFindings } from './reconciliation.js';
export { callerUserId, readBalance } from './balance.js';
export type { BalanceView } from './balance.js';
export { billingLoginLinkResponseSchema, issueBillingLoginToken } from './login-link.js';
export type { BillingLoginLinkResponse } from './login-link.js';
export { groupEffectiveRemainingNanoUsd } from './group-budget.js';
export { resolveBudgetScopes } from './budget-resolution.js';
export type {
  BudgetResolutionRequest,
  MemberBudgetScopeRequest,
  ConversationBudgetScopeRequest,
} from './budget-resolution.js';
export {
  DEFAULT_TRANSACTIONS_PAGE_LIMIT,
  DEFAULT_USAGE_PAGE_LIMIT,
  readBalanceHistory,
  readCostByModel,
  readLedgerTransactions,
  readSpendingByConversation,
  readSpendingOverTime,
  readTokenUsageOverTime,
  readUsageBreakdown,
  readUsageModels,
  readUsageSummary,
  usageBreakdownQuerySchema,
} from './usage-analytics.js';
export type {
  LedgerTransactionsPage,
  LedgerTransactionView,
  UsageBreakdownResult,
  UsageDateRangeParams,
} from './usage-analytics.js';

// Route-seam re-exports: routes.ts may import only this barrel and the
// middleware (boundaries), so the lib surface routes need travels through
// here.
export { createErrorResponse } from '../../../lib/errors/index.js';
export type { DomainError, DomainErrorCode } from '../../../lib/errors/index.js';
export {
  idempotencyExempt,
  idempotent,
  readIdempotencyKey,
  runMutation,
} from '../../../lib/idempotency/index.js';
export { okAsync } from '../../../lib/result/index.js';
export type { JobRegistry } from '../../../lib/jobs/index.js';
export type {
  AccountDefensePort,
  AccountLockedEmailPort,
  BillingStores,
  PaymentProvider,
} from '../ports/index.js';
