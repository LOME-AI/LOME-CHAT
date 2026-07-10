import { ERROR_CODES } from '@hushbox/shared';
import {
  COST_CIRCUIT_MULTIPLIER,
  admitTrialSpend,
  incrementTrialSpend,
} from '../../billing/index.js';
import { createFencedSettlementHook, keyRowCompletion } from '../../workflows/index.js';
import type { TrialSpendDeps } from '../../billing/index.js';
import type { SettlementCommit } from '../../workflows/index.js';
import type {
  FlowHookBindings,
  RunContext,
  SettlementCharge,
  SettlementHook,
  TrialRunIdentity,
} from '@hushbox/shared';
import type { Database } from '@hushbox/db';
import type { Telemetry } from '../../../lib/telemetry/index.js';

/**
 * The trial policy: the no-persist / no-charge variant of the ONE chat-turn
 * pipeline. Trial reuses the same executor, the same run referee, and the same
 * fenced settlement runner as the paid turn; only the two policy hooks differ.
 *
 * Admission is a read-and-compare against the daily cumulative trial-spend
 * counter (a single $50/day ceiling fed by real provider cost, NOT a
 * per-run reservation): below the cap admits and supplies the
 * interpreter-required cost-circuit readout (the circuit still bounds a runaway
 * trial generation even though the trial user is never charged); at the cap it
 * refuses. Settlement writes NOTHING to the DB, but after the fenced
 * transaction commits it folds this run's actual provider cost into the daily
 * counter — a post-commit, best-effort side-effect that never touches the
 * settlement transaction.
 */

/** The run context of a trial turn — the only shape the trial policy binds over. */
export type TrialRunContext = TrialRunIdentity & {
  readonly runId: string;
  readonly fence: RunContext['fence'];
};

/**
 * The infra the trial hooks close over: Redis (the daily-spend counter), the DB
 * (the fenced key-row flip), and telemetry (the one-shot cap-crossed alert).
 */
export interface TrialHookDeps {
  readonly redis: TrialSpendDeps['redis'];
  readonly db: Database;
  readonly telemetry: Telemetry;
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
 * The trial admission hook: read the day's cumulative trial spend and admit
 * while it is below the cap, refusing with TRIAL_CAPACITY_REACHED once the
 * cap is reached. There is NO reservation and NO wallet hold — a trial user has
 * no wallet, and a small burst overshoot is accepted (bounded by the per-message
 * cost). The grant still carries the cost-circuit readout derived from the
 * server-computed estimate. Redis down fails closed to ADMISSION_UNAVAILABLE,
 * exactly like paid admission. No telemetry is emitted on a refusal — a
 * post-cap request stream would otherwise flood the alert channel.
 */
export function createTrialAdmissionHook(
  deps: TrialHookDeps,
  context: TrialRunContext,
  clock: () => Date
): FlowHookBindings['admission'] {
  return (request) => {
    const now = clock();
    return admitTrialSpend({ redis: deps.redis }, { now }).match(
      (decision) =>
        decision.admitted
          ? {
              admitted: true as const,
              holdRef: context.runId,
              circuit: {
                estimateNanoUsd: request.estimate,
                costCircuitMultiplier: COST_CIRCUIT_MULTIPLIER,
                costCircuitLimitNanoUsd: request.estimate * COST_CIRCUIT_MULTIPLIER,
              },
            }
          : { admitted: false as const, code: ERROR_CODES.TRIAL_CAPACITY_REACHED },
      // `admitTrialSpend` fails closed with a typed error (Redis unavailable or
      // a corrupt counter); either ambiguity refuses rather than over-admits.
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

// Display-only USD projection for the crossing alert's `costUsd` dimension.
// Ledger and admission money stay integer nano-USD bigint; this ONE conversion
// feeds a telemetry double (never settlement math — the documented use of the
// `costUsd` field). The day's total is bounded near the cap, far below 2^53, so
// the projection is exact.
const NANO_USD_PER_USD = 1_000_000_000;
function displayUsd(nanoUsd: bigint): number {
  return Number(nanoUsd) / NANO_USD_PER_USD;
}

/**
 * Post-commit, best-effort: fold a settled trial run's ACTUAL provider cost
 * (Σ base cost — what WE spent, never the marked-up price a trial user is not
 * charged) into the daily counter, and alert ONCE if this run crossed the cap.
 *
 * Runs OUTSIDE the fenced settlement transaction (which is DB-only — no Redis
 * call inside it, ever). A lost increment slightly under-counts an abuse budget,
 * which is acceptable; it must NEVER fail a run that already settled, so every
 * failure is swallowed into a best-effort warning. A run with no billable cost
 * touches nothing.
 */
export async function recordTrialSpend(
  deps: TrialHookDeps,
  now: Date,
  charges: readonly SettlementCharge[]
): Promise<void> {
  const total = charges.reduce((sum, charge) => sum + charge.baseCostNanoUsd, 0n);
  if (total <= 0n) return;
  await incrementTrialSpend({ redis: deps.redis }, { amountNanoUsd: total, now }).match(
    (increment) => {
      if (!increment.crossed) return;
      // Exactly one alert per day: only the atomic increment that first reaches
      // the cap reports `crossed`, so this fires once and re-arms after the
      // counter's midnight expiry. The UTC day is implicit in the event
      // timestamp (the SafeLogFields allowlist carries no date field). NEVER
      // emitted on an admission refusal (that path has no telemetry at all).
      deps.telemetry.warn('trial daily spend cap crossed', {
        costUsd: displayUsd(increment.total),
      });
      // `warn` is the Workers-Logs structured record; only `captureError` feeds
      // Sentry, so the trial system's one financial alarm must page here too.
      // The message is a compile-time literal and content-free — the safe USD
      // display double already rides the `warn` above; nothing else leaks.
      deps.telemetry.captureError(
        new Error('trial daily spend cap crossed'),
        'trial_daily_cap_crossed'
      );
    },
    () => {
      deps.telemetry.warn('trial daily spend increment skipped', {});
    }
  );
}

/**
 * The trial settlement hook: the fenced no-persist / no-charge settlement, then
 * a post-commit best-effort fold of the run's actual provider cost into the
 * daily counter. `await fenced(request)` commits the DB-only settlement (or
 * throws, failing the run and skipping the fold) BEFORE the Redis increment
 * runs — the settlement transaction never contains a Redis call.
 */
export function createTrialSettlementHook(
  deps: TrialHookDeps,
  context: TrialRunContext,
  clock: () => Date
): SettlementHook {
  const fenced = createFencedSettlementHook({
    db: deps.db,
    fence: context.fence,
    complete: keyRowCompletion({ runId: context.runId }),
    commit: createTrialSettlementCommit(),
  });
  return async (request) => {
    await fenced(request);
    await recordTrialSpend(deps, clock(), request.charges);
  };
}

/** The per-binder collaborators the trial policy closes over (just the clock). */
export function bindTrialHooks(
  deps: TrialHookDeps,
  context: TrialRunContext,
  clock: () => Date
): FlowHookBindings {
  return {
    admission: createTrialAdmissionHook(deps, context, clock),
    settlement: createTrialSettlementHook(deps, context, clock),
  };
}
