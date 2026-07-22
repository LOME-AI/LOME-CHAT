import { match } from 'ts-pattern';
import { ERROR_CODES } from '@hushbox/shared';
import type { ErrorCode } from '@hushbox/shared';
import type { DomainError } from '../../../lib/errors/index.js';

/**
 * The closed set of terminal run failures. Every failure leaves zero
 * committed effects — the engine never settles a failed run — so these are
 * bookkeeping for telemetry and the typed wire code, never money.
 */
export type RunFailure =
  // `code` carries a specific validation refusal (e.g. an unsupported video
  // resolution surfaced while pricing) through the pre-admission path; absent,
  // it stays the generic VALIDATION.
  | { readonly kind: 'inputs-invalid'; readonly code?: ErrorCode }
  | { readonly kind: 'byte-budget-exceeded' }
  | { readonly kind: 'admission-refused'; readonly code: ErrorCode }
  | { readonly kind: 'cost-circuit-tripped' }
  // `code` carries a specific provider-failure reason (content policy, context
  // length, network) to the client; absent, it stays the generic UNAVAILABLE.
  | { readonly kind: 'node-failed'; readonly nodeId: string; readonly code?: ErrorCode }
  // Every branch of a multi-model turn failed, so settlement had zero charges to
  // commit — a real "the providers were unavailable" outcome, not an engine
  // defect: the run is rerouted to UNAVAILABLE and never captured to Sentry.
  | { readonly kind: 'all-branches-failed' }
  // Ciphertext storage (R2/MinIO) was unreachable while persisting generated
  // media — an infra outage at the storage seam, not an engine defect: the run
  // fails UNAVAILABLE and is never captured to Sentry.
  | { readonly kind: 'storage-unavailable' }
  // An ordinary settlement concurrency conflict (the fork tip moved, the fork
  // vanished mid-run, or the epoch wrapped) — the settlement hook throws the
  // typed SettlementConflictError sentinel. Expected under group-chat
  // concurrency, not an engine defect: `code` carries the specific client wire
  // code (FORK_TIP_CONFLICT / CONFLICT) and the run is never captured to Sentry.
  | { readonly kind: 'settlement-conflict'; readonly code: ErrorCode }
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

/**
 * The typed error the chat media-persist run throws when a ciphertext
 * `storage.put` failed for an availability reason (`unavailable`/`timeout`
 * from the storage adapter's Result channel). Like `AllBranchesFailedError`,
 * it lives beside its failure kind so the producer (chat's file-part mapper
 * and flush barrier, importing via the workflows barrel) and the engine's
 * catch sites are compile-linked. The engine discriminates it via
 * `instanceof`, reroutes to `'storage-unavailable'` → UNAVAILABLE, and never
 * captures it — infra unavailability is not a defect.
 */
export class StorageUnavailableError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'StorageUnavailableError';
  }
}

/**
 * The typed sentinel the chat settlement hook throws for an ordinary settlement
 * concurrency conflict — the fork this turn extends vanished mid-run, its tip
 * moved out from under the settling turn, or the captured epoch wrapped
 * (rotation or membership change). Like the sentinels above it lives beside its
 * failure kind so the producer (chat's settlement hook, importing it via the
 * workflows barrel) and the engine's `settle()` catch are compile-linked. The
 * engine discriminates it via `instanceof`, reroutes to `'settlement-conflict'`,
 * and NEVER captures it — these are expected races inherent to group-chat
 * concurrency, not defects (observability doctrine: expected domain failures
 * are `Result` `{code}` values, never Sentry).
 *
 * It carries the underlying `DomainError` — bearing the chat-specific wire code
 * as its `wireCode` override (FORK_TIP_CONFLICT for fork-tip races, CONFLICT for
 * epoch-wrap) — which the engine projects to the client through
 * `domainWireCode`. The genuinely-unreachable fork-tip CAS defect keeps throwing
 * a plain `Error`, so it still routes to `'defect'` + Sentry.
 */
export class SettlementConflictError extends Error {
  constructor(
    readonly domainError: DomainError,
    message: string
  ) {
    super(message);
    this.name = 'SettlementConflictError';
  }
}

export function runFailureCode(failure: RunFailure): ErrorCode {
  return match(failure)
    .with({ kind: 'inputs-invalid' }, (invalid) => invalid.code ?? ERROR_CODES.VALIDATION)
    .with({ kind: 'byte-budget-exceeded' }, () => ERROR_CODES.VALIDATION)
    .with({ kind: 'admission-refused' }, (refused) => refused.code)
    .with({ kind: 'cost-circuit-tripped' }, () => ERROR_CODES.INSUFFICIENT_ADMISSION)
    .with({ kind: 'node-failed' }, (failed) => failed.code ?? ERROR_CODES.UNAVAILABLE)
    .with({ kind: 'all-branches-failed' }, () => ERROR_CODES.UNAVAILABLE)
    .with({ kind: 'storage-unavailable' }, () => ERROR_CODES.UNAVAILABLE)
    .with({ kind: 'settlement-conflict' }, (conflict) => conflict.code)
    .with({ kind: 'defect' }, () => ERROR_CODES.INTERNAL)
    .exhaustive();
}
