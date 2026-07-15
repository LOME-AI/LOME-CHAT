import { assertType, describe, expect, it } from 'vitest';

import { FINGERPRINT_CODES, type FingerprintCode } from './fingerprint-codes.js';

describe('FINGERPRINT_CODES registry', () => {
  it('holds every captureError fingerprint code in use as its exact emitted string', () => {
    // The full set is frozen: a rename or addition is a deliberate, visible
    // diff here, and any code emitted at a `captureError` call site must be a
    // member — the registry is the exhaustive source of Sentry fingerprints.
    expect(new Set(Object.values(FINGERPRINT_CODES))).toStrictEqual(
      new Set([
        'cron_unknown_schedule',
        'cron_entry_failed',
        'INTERNAL',
        'job_pass_failed',
        'job_dead_letter',
        'job_completion_write_failed',
        'jobs_stuck',
        'media_gc_delete_failed',
        'workflow_node_defect',
        'workflow_settlement_defect',
        'workflow_run_defect',
        'inference_provider_cost_unavailable',
        'model_pricing_unit_unknown',
        'model_type_unknown',
        'model_release_date_missing',
        'model_video_resolution_fallback',
        'trial_daily_cap_crossed',
        'admin_ephemeral_effect_failed',
        'admin_op_notification_failed',
        'admin_access_enrollment_event',
        'admin_access_unexpected_actor',
        'ledger_conservation_unbalanced',
        'ledger_wallet_balance_drift',
        'wallet_snapshot_audit_failed',
        'wallet_snapshot_seq_ahead',
      ])
    );
  });

  it('single-sources the top-level INTERNAL fingerprint from the shared wire code', () => {
    expect(FINGERPRINT_CODES.internal).toBe('INTERNAL');
  });

  it('types a registered code as FingerprintCode and rejects an unregistered literal', () => {
    assertType<FingerprintCode>(FINGERPRINT_CODES.jobDeadLetter);
    // @ts-expect-error an unregistered literal is not a fingerprint code —
    // this is the typo-proof mechanism: a mistyped code fails to compile.
    assertType<FingerprintCode>('not_a_registered_fingerprint_code');
    expect(true).toBe(true);
  });
});
