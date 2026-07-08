import { z } from 'zod';
import { defineKey } from '../../../lib/redis/index.js';
import { SNAPSHOT_TTL_SECONDS } from './constants.js';
import type { Variables } from '../../../lib/context/index.js';

/**
 * The per-request Redis client as the pipeline types it — named here so
 * domain signatures never import the infra module (boundaries: only adapters
 * and lib may).
 */
export type RedisClient = Variables['redis'];

/**
 * Hold-hash entries: `"<estimateNanoUsd>:<expiresAtMs>"` per hold id. Expiry
 * rides in the value because hash fields have no per-field TTL — the
 * admission script prunes lazily on every pass (recovery is in-mechanism).
 */
export const holdFieldSchema = z.string().regex(/^\d+:\d+$/);

/**
 * The daily trial-spend counter value: cumulative nano-USD as a bigint.
 * `z.coerce.bigint` lifts either shape Upstash returns (a JS number for values
 * within 2^53 — the bounded day's-spend case — or a string for larger ones)
 * to a bigint, so the comparison stays integer money end to end. A negative
 * value is corruption, not a legal state; it fails validation and admission
 * fails closed on it.
 */
export const trialDailySpendSchema = z.coerce.bigint().nonnegative();

/** A full UTC day bounds the counter; the live expiry is anchored to the next UTC midnight. */
const TRIAL_SPEND_TTL_SECONDS = 24 * 60 * 60;

/**
 * Snapshot value: balance as a decimal string (bigint-safe), CAS sequence,
 * and the wallet type the admission script derives the balance check from
 * (immutable per wallet, so caching it can never go stale).
 */
export const walletSnapshotSchema = z.object({
  balanceNanoUsd: z.string(),
  ledgerSeq: z.number(),
  type: z.enum(['purchased', 'free']),
});

/**
 * The 15-minute platform deadline ceiling plus the hold margin bounds every
 * hold, so a holds hash whose key-level TTL uses this value always outlives
 * its longest member. Admission validates each hold's TTL against it.
 */
export const MAX_HOLD_TTL_SECONDS = 16 * 60;

/** The billing slice's Redis registry entries (admission is the only user). */
export const BILLING_KEYS = {
  // Per-wallet holds hash: holdId → "estimate:expiresAtMs". Written only by
  // the admission Lua script (atomic check-and-add) and releaseHold.
  walletHolds: defineKey({
    schema: holdFieldSchema,
    ttlSeconds: MAX_HOLD_TTL_SECONDS,
    buildKey: (walletId: string) => `billing:admission:wallet:${walletId}`,
  }),
  // Per-budget-scope holds hash; the period key rides inside the scope id
  // (e.g. `member:<memberId>:<YYYY-MM>`), so a period rollover starts an
  // empty hash with no mutation.
  scopeHolds: defineKey({
    schema: holdFieldSchema,
    ttlSeconds: MAX_HOLD_TTL_SECONDS,
    buildKey: (scopeId: string) => `billing:admission:scope:${scopeId}`,
  }),
  // Balance snapshot, written through every ledger-committing transaction
  // (CAS on ledgerSeq); the short TTL is the staleness bound — a miss forces
  // a Postgres re-read.
  walletSnapshot: defineKey({
    schema: walletSnapshotSchema,
    ttlSeconds: SNAPSHOT_TTL_SECONDS,
    buildKey: (walletId: string) => `billing:admission:snapshot:${walletId}`,
  }),
  // Daily cumulative trial-spend counter: one key per UTC day, incremented by
  // each trial run's actual provider cost at settlement and read by trial
  // admission. `ttlSeconds` documents the day-long lifetime; the LIVE expiry is
  // anchored to the next UTC midnight (NX) inside the increment script, so the
  // window resets at one midnight and is never extended (period-key discipline,
  // no reset job).
  trialDailySpend: defineKey({
    schema: trialDailySpendSchema,
    ttlSeconds: TRIAL_SPEND_TTL_SECONDS,
    buildKey: (utcDay: string) => `trial:global:spend:${utcDay}`,
  }),
} as const;
