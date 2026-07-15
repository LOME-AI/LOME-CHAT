import { ERROR_CODES } from '@hushbox/shared';

/**
 * The single, exhaustive registry of every `captureError` fingerprint code in
 * use. A fingerprint code groups a logical failure across call paths in Sentry
 * (`sentry-adapter` puts it in `tags.errorCode` and the fingerprint), so the
 * strings must stay stable, finite, and collision-free — a mistyped literal
 * silently fragments one failure into many groups.
 *
 * Every call site references a member of this object; nothing passes an inline
 * literal. `captureError`'s parameter is typed `FingerprintCode` (below), so an
 * unregistered or misspelled code fails to compile — the registry is both the
 * source of truth and the typo guard.
 *
 * `internal` is single-sourced from the shared wire code: the top-level error
 * handler in `app.ts` fingerprints every uncaught error as `ERROR_CODES.INTERNAL`,
 * and this entry keeps that value in the union without duplicating the literal.
 */
export const FINGERPRINT_CODES = {
  cronUnknownSchedule: 'cron_unknown_schedule',
  cronEntryFailed: 'cron_entry_failed',
  internal: ERROR_CODES.INTERNAL,
  jobPassFailed: 'job_pass_failed',
  jobDeadLetter: 'job_dead_letter',
  jobCompletionWriteFailed: 'job_completion_write_failed',
  jobsStuck: 'jobs_stuck',
  mediaGcDeleteFailed: 'media_gc_delete_failed',
  workflowNodeDefect: 'workflow_node_defect',
  workflowSettlementDefect: 'workflow_settlement_defect',
  workflowRunDefect: 'workflow_run_defect',
  inferenceProviderCostUnavailable: 'inference_provider_cost_unavailable',
  modelPricingUnitUnknown: 'model_pricing_unit_unknown',
  modelTypeUnknown: 'model_type_unknown',
  modelReleaseDateMissing: 'model_release_date_missing',
  modelVideoResolutionFallback: 'model_video_resolution_fallback',
  trialDailyCapCrossed: 'trial_daily_cap_crossed',
  adminEphemeralEffectFailed: 'admin_ephemeral_effect_failed',
  adminOpNotificationFailed: 'admin_op_notification_failed',
  adminAccessEnrollmentEvent: 'admin_access_enrollment_event',
  adminAccessUnexpectedActor: 'admin_access_unexpected_actor',
  ledgerConservationUnbalanced: 'ledger_conservation_unbalanced',
  ledgerWalletBalanceDrift: 'ledger_wallet_balance_drift',
  walletSnapshotAuditFailed: 'wallet_snapshot_audit_failed',
  walletSnapshotSeqAhead: 'wallet_snapshot_seq_ahead',
} as const;

/** The union of every registered fingerprint code — `captureError`'s parameter type. */
export type FingerprintCode = (typeof FINGERPRINT_CODES)[keyof typeof FINGERPRINT_CODES];
