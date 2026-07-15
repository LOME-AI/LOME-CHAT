import {
  FREE_ALLOWANCE_CENTS_VALUE,
  NANO_USD_PER_CENT,
  WELCOME_CREDIT_CENTS,
} from '@hushbox/shared';

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
export const WELCOME_CREDIT_NANO_USD = BigInt(WELCOME_CREDIT_CENTS) * NANO_USD_PER_CENT;

/** Free-tier daily allowance cap, tracked as period-keyed spending rows. */
export const DAILY_ALLOWANCE_NANO_USD = BigInt(FREE_ALLOWANCE_CENTS_VALUE) * NANO_USD_PER_CENT;

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
 * The daily trial-spend cap: a single cumulative ceiling ($50) on aggregate
 * free-trial provider spend per UTC day. Trial runs never touch a wallet, so
 * this is the only bound on how much unpaid provider spend we absorb in a day.
 * It is tracked as one period-keyed Redis counter (`trial:global:spend:<day>`)
 * fed by each run's ACTUAL provider cost at settlement; admission reads and
 * compares it (no reservation), so a Sybil flood is refused once the day's
 * real spend reaches the cap. A tunable abuse-mitigation figure, not a
 * correctness constant.
 */
export const TRIAL_DAILY_SPEND_CAP_NANO_USD = 50_000_000_000n;
