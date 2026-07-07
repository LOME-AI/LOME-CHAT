import { FREE_ALLOWANCE_CENTS_VALUE, WELCOME_CREDIT_CENTS } from '@hushbox/shared';

const NANO_PER_CENT = 10_000_000n;

/**
 * K — the mid-run cost-circuit multiplier: a run is killed when observed
 * usage accrual exceeds `hold × K`. Initial value 5 gives headroom above the
 * documented 4.4× estimate-undershoot worst case. The admission hold readout
 * publishes it; the workflow engine's circuit enforces it at step/branch/node
 * boundaries, so the true per-run exposure bound is `hold × K` plus one
 * maximum step cost.
 */
export const COST_CIRCUIT_MULTIPLIER = 5n;

/** One-time signup credit, granted as promo ledger legs at provisioning. */
export const WELCOME_CREDIT_NANO_USD = BigInt(WELCOME_CREDIT_CENTS) * NANO_PER_CENT;

/** Free-tier daily allowance cap, tracked as period-keyed spending rows. */
export const DAILY_ALLOWANCE_NANO_USD = BigInt(FREE_ALLOWANCE_CENTS_VALUE) * NANO_PER_CENT;

/**
 * Added to the run deadline to size a hold's TTL: the hold must outlive the
 * run it admits (settlement releases it early; expiry is the recovery path,
 * never the primary mechanism).
 */
export const HOLD_TTL_MARGIN_SECONDS = 60;

/**
 * Redis balance-snapshot TTL — the staleness bound: a miss forces a Postgres
 * re-read, so a stale snapshot can never outlive this window.
 */
export const SNAPSHOT_TTL_SECONDS = 30;

/**
 * The global trial/welcome Sybil budget: the aggregate ceiling on CONCURRENT
 * trial provider exposure. Trial runs never touch a wallet, so this is the
 * only bound on how much unpaid provider spend can be in flight at once. It is
 * enforced as scope-only admission holds against one period-keyed scope
 * (`trialGlobalScopeId`); each admitted run reserves its worst-case estimate
 * and the reservation auto-expires with the run, so the budget caps
 * concurrency × per-run ceiling rather than a cumulative daily total. Sized
 * to admit healthy real concurrency while a Sybil flood exhausts it and is
 * refused — a tunable abuse-mitigation figure, not a correctness constant.
 */
export const TRIAL_GLOBAL_BUDGET_NANO_USD = 50_000_000_000n;
