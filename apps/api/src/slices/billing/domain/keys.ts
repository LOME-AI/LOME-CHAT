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
} as const;
