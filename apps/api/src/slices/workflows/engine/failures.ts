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
  // Every branch of a multi-model turn failed, so settlement had zero charges to
  // commit — a real "the providers were unavailable" outcome, not an engine
  // defect: the run is rerouted to UNAVAILABLE and never captured to Sentry.
  | { readonly kind: 'all-branches-failed' }
  | { readonly kind: 'defect' };

/**
 * Wire-code projection for FlowRunOutcome. Cost-circuit trips reuse
 * INSUFFICIENT_ADMISSION (the run exceeded its authorized cost envelope) and
 * byte-budget breaches reuse VALIDATION — the closed error-code set has no
 * dedicated codes for either yet; the mapping is deliberate, not accidental.
 */
/**
 * The typed sentinel a settlement hook throws when the run produced zero
 * billable content — every branch of a multi-model turn failed. It lives here,
 * beside the `'all-branches-failed'` failure kind, so the producer (chat's
 * settlement hook, which imports it via the workflows barrel) and the engine's
 * `settle()` catch are compile-linked: a rename breaks typecheck, never
 * silently misroutes the all-models-failed turn to INTERNAL + Sentry. The
 * engine discriminates it with `instanceof` (an intra-slice import — the engine
 * must not depend on the chat slice), reroutes to `'all-branches-failed'` →
 * UNAVAILABLE, and never captures it. It is a runtime class, not an
 * `import type`.
 */
export class AllBranchesFailedError extends Error {
  constructor(message = 'settlement: every branch failed, no billable content produced') {
    super(message);
    this.name = 'AllBranchesFailedError';
  }
}

export function runFailureCode(failure: RunFailure): ErrorCode {
  return match(failure)
    .with({ kind: 'inputs-invalid' }, () => ERROR_CODES.VALIDATION)
    .with({ kind: 'byte-budget-exceeded' }, () => ERROR_CODES.VALIDATION)
    .with({ kind: 'admission-refused' }, (refused) => refused.code)
    .with({ kind: 'cost-circuit-tripped' }, () => ERROR_CODES.INSUFFICIENT_ADMISSION)
    .with({ kind: 'node-failed' }, () => ERROR_CODES.UNAVAILABLE)
    .with({ kind: 'all-branches-failed' }, () => ERROR_CODES.UNAVAILABLE)
    .with({ kind: 'defect' }, () => ERROR_CODES.INTERNAL)
    .exhaustive();
}
