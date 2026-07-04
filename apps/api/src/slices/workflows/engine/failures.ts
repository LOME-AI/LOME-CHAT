import { match } from 'ts-pattern';
import { ERROR_CODES } from '@hushbox/shared';
import type { ErrorCode } from '@hushbox/shared';

/**
 * The closed set of terminal run failures. Every failure leaves zero
 * committed effects — the engine never settles a failed run — so these are
 * bookkeeping for telemetry and the typed wire code, never money.
 */
export type RunFailure =
  | { readonly kind: 'inputs-invalid' }
  | { readonly kind: 'byte-budget-exceeded' }
  | { readonly kind: 'admission-refused'; readonly code: ErrorCode }
  | { readonly kind: 'cost-circuit-tripped' }
  | { readonly kind: 'node-failed'; readonly nodeId: string }
  | { readonly kind: 'defect' };

/**
 * Wire-code projection for FlowRunOutcome. Cost-circuit trips reuse
 * INSUFFICIENT_ADMISSION (the run exceeded its authorized cost envelope) and
 * byte-budget breaches reuse VALIDATION — the closed error-code set has no
 * dedicated codes for either yet; the mapping is deliberate, not accidental.
 */
export function runFailureCode(failure: RunFailure): ErrorCode {
  return match(failure)
    .with({ kind: 'inputs-invalid' }, () => ERROR_CODES.VALIDATION)
    .with({ kind: 'byte-budget-exceeded' }, () => ERROR_CODES.VALIDATION)
    .with({ kind: 'admission-refused' }, (refused) => refused.code)
    .with({ kind: 'cost-circuit-tripped' }, () => ERROR_CODES.INSUFFICIENT_ADMISSION)
    .with({ kind: 'node-failed' }, () => ERROR_CODES.UNAVAILABLE)
    .with({ kind: 'defect' }, () => ERROR_CODES.INTERNAL)
    .exhaustive();
}
