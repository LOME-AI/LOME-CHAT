import { DEADLINE_CLASS_MS, ERROR_CODES } from '@hushbox/shared';
import {
  COST_CIRCUIT_MULTIPLIER,
  TRIAL_GLOBAL_BUDGET_NANO_USD,
  admitScope,
  trialGlobalScopeId,
} from '../../billing/index.js';
import { createFencedSettlementHook, keyRowCompletion } from '../../workflows/index.js';
import type { ScopeAdmissionDeps } from '../../billing/index.js';
import type { SettlementCommit } from '../../workflows/index.js';
import type {
  FlowHookBindings,
  RunContext,
  TrialRunIdentity,
  WorkflowDefinition,
} from '@hushbox/shared';
import type { Database } from '@hushbox/db';

/**
 * The trial policy: the no-persist / no-charge variant of the ONE chat-turn
 * pipeline. Trial reuses the same executor, the same run referee, and the same
 * fenced settlement runner as the paid turn; only the two policy hooks differ.
 * Admission enforces the global trial/welcome Sybil budget (a scope-only Redis
 * reservation, NO wallet hold) and supplies the interpreter-required
 * cost-circuit readout — which bounds our provider spend on a runaway trial
 * generation even though the trial user is never charged. Settlement is a no-op
 * commit that writes nothing and charges nothing; the fenced runner still flips
 * the idempotency-key row, so a trial resubmit is idempotent.
 */

/** The run context of a trial turn — the only shape the trial policy binds over. */
export type TrialRunContext = TrialRunIdentity & {
  readonly runId: string;
  readonly fence: RunContext['fence'];
};

/** The infra the trial hooks close over: Redis (Sybil scope) and the DB (fenced flip). */
export interface TrialHookDeps {
  readonly redis: ScopeAdmissionDeps['redis'];
  readonly db: Database;
}

/**
 * The trial policy runs only under a trial identity (no wallet, no epoch). A
 * `trial`-hooked definition arriving with any other identity is a composition
 * defect — the binder fails fast rather than bind the trial policy to the wrong
 * identity (the mirror of `requirePaidContext`).
 */
export function requireTrialContext(context: RunContext): TrialRunContext {
  if (context.mode !== 'trial') {
    throw new Error(
      `chat runtime: the trial policy requires a trial run identity, got "${context.mode}"`
    );
  }
  return context;
}

/**
 * The trial admission hook: reserve the run's worst-case estimate against the
 * global trial Sybil scope (bounding aggregate concurrent trial exposure) and
 * hand the interpreter the cost-circuit readout derived from that same
 * estimate. There is NO wallet hold — a trial user has no wallet. A Sybil-budget
 * refusal maps to the admission budget-refusal code; Redis down fails closed to
 * ADMISSION_UNAVAILABLE, exactly like paid admission.
 */
export function createTrialAdmissionHook(
  deps: TrialHookDeps,
  context: TrialRunContext,
  definition: WorkflowDefinition,
  clock: () => Date
): FlowHookBindings['admission'] {
  return (request) => {
    const now = clock();
    return admitScope(
      { redis: deps.redis },
      {
        scopeId: trialGlobalScopeId(now),
        holdId: context.runId,
        estimateNanoUsd: request.estimate,
        remainingNanoUsd: TRIAL_GLOBAL_BUDGET_NANO_USD,
        deadlineSeconds: DEADLINE_CLASS_MS[definition.deadlineClass] / 1000,
        now,
      }
    ).match(
      (decision) =>
        decision.admitted
          ? {
              admitted: true as const,
              holdRef: decision.holdId,
              circuit: {
                estimateNanoUsd: request.estimate,
                costCircuitMultiplier: COST_CIRCUIT_MULTIPLIER,
                costCircuitLimitNanoUsd: request.estimate * COST_CIRCUIT_MULTIPLIER,
              },
            }
          : { admitted: false as const, code: ERROR_CODES.INSUFFICIENT_ADMISSION },
      // `admitScope` fails closed with exactly one error: Redis unavailable (a
      // reject or an unknown script outcome). There is no other error channel,
      // so the whole error arm maps to ADMISSION_UNAVAILABLE.
      () => ({ admitted: false as const, code: ERROR_CODES.ADMISSION_UNAVAILABLE })
    );
  };
}

/** The no-op commit body: persists nothing, charges nothing (closes over nothing). */
const trialSettlementCommit: SettlementCommit = () => Promise.resolve();

/**
 * The trial settlement commit: no-persist / no-charge. It writes NOTHING — no
 * epoch-key read, no message/content, no ledger/usage rows. The fenced runner
 * that composes it still performs the `claimed → succeeded` key-row flip, so a
 * trial retry replays rather than re-executes. saved ⟺ billed holds trivially:
 * nothing saved, nothing billed.
 */
export function createTrialSettlementCommit(): SettlementCommit {
  return trialSettlementCommit;
}

/** The per-binder collaborators the trial policy closes over (just the clock). */
export function bindTrialHooks(
  deps: TrialHookDeps,
  context: TrialRunContext,
  definition: WorkflowDefinition,
  clock: () => Date
): FlowHookBindings {
  return {
    admission: createTrialAdmissionHook(deps, context, definition, clock),
    settlement: createFencedSettlementHook({
      db: deps.db,
      fence: context.fence,
      complete: keyRowCompletion({ runId: context.runId }),
      commit: createTrialSettlementCommit(),
    }),
  };
}
