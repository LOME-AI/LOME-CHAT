import { afterAll, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { Redis } from '@upstash/redis';
import {
  LOCAL_NEON_DEV_CONFIG,
  contentItems,
  createDb,
  idempotencyKeys,
  ledgerEntries,
  messages,
  usageRecords,
} from '@hushbox/db';
import {
  TRIAL_DAILY_SPEND_CAP_NANO_USD,
  admitTrialSpend,
  incrementTrialSpend,
} from '../../billing/index.js';
import { SettlementFenceLost } from '../../workflows/index.js';
import { claimKeyRow } from '../../../lib/idempotency/index.js';
import { CHAT_TURN_ROUTE } from './constants.js';
import { createTrialSettlementHook } from './trial.js';
import type { TrialHookDeps } from './trial.js';
import type { SettlementCharge, SettlementRequest } from '@hushbox/shared';
import type { Telemetry } from '../../../lib/telemetry/index.js';

/**
 * Trial settlement is no-persist / no-charge: the fenced runner still flips the
 * idempotency-key row (so a trial resubmit replays), but the commit writes ZERO
 * domain rows. AFTER that DB-only transaction commits, the run's ACTUAL
 * provider cost is folded into the daily trial-spend counter — a post-commit,
 * best-effort side-effect that never touches the settlement transaction and
 * never fails a run that already settled.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!DATABASE_URL || !UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error(
    'DATABASE_URL, UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required for trial settlement integration tests'
  );
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });
const deadRedis = new Redis({ url: 'http://localhost:1', token: 'token' });
const createdKeyRowIds: string[] = [];

/** A distinct UTC day per test so trial-spend counters never collide. */
let dayOffset = 0;
function freshNow(): Date {
  dayOffset += 1;
  return new Date(Date.UTC(2031, 0, dayOffset, 12, 0, 0));
}
function counterKey(now: Date): string {
  return `trial:global:spend:${now.toISOString().slice(0, 10)}`;
}

function telemetrySpy(): Telemetry {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    emitMetric: vi.fn(),
    captureError: vi.fn(),
  } as unknown as Telemetry;
}

function deps(overrides: Partial<TrialHookDeps> = {}): TrialHookDeps {
  return { redis, db, telemetry: telemetrySpy(), ...overrides };
}

afterAll(async () => {
  if (createdKeyRowIds.length > 0) {
    await db.delete(idempotencyKeys).where(inArray(idempotencyKeys.id, createdKeyRowIds));
  }
  await Promise.all(
    Array.from({ length: dayOffset }, (_unused, index) =>
      redis.del(counterKey(new Date(Date.UTC(2031, 0, index + 1, 12, 0, 0))))
    )
  );
  await db.$client.end();
});

async function claimTrialFence(
  sessionId: string,
  runKey: string,
  runId: string
): Promise<{ id: string; executorId: string; claims: number }> {
  const executorId = crypto.randomUUID();
  const claimed = await claimKeyRow(db, {
    // A trial run's key-row scope is its session id (a uuid), never a wallet user.
    scope: { userId: sessionId, route: CHAT_TURN_ROUTE, key: runKey },
    kind: 'run',
    bodyHash: 'trial-body-hash',
    executorId,
    leaseSeconds: 90,
    runId,
  });
  const claim = claimed._unsafeUnwrap();
  if (claim.outcome !== 'executor') throw new Error('expected an executor claim');
  createdKeyRowIds.push(claim.row.id);
  return { id: claim.row.id, executorId, claims: claim.row.claims };
}

function charge(baseCostNanoUsd: bigint): SettlementCharge {
  return {
    key: 'answer',
    modelId: 'trial/model',
    providerName: 'trial-provider',
    modality: 'text',
    generationId: 'gen-1',
    baseCostNanoUsd,
    isEstimated: false,
  };
}

function request(runKey: string, charges: readonly SettlementCharge[]): SettlementRequest {
  return { runKey, outputs: {}, charges };
}

async function context(now: Date): Promise<TrialRunContextFields> {
  const sessionId = crypto.randomUUID();
  const runKey = crypto.randomUUID();
  const runId = crypto.randomUUID();
  const fence = await claimTrialFence(sessionId, runKey, runId);
  return { sessionId, runKey, runId, fence, now };
}

interface TrialRunContextFields {
  readonly sessionId: string;
  readonly runKey: string;
  readonly runId: string;
  readonly fence: { id: string; executorId: string; claims: number };
  readonly now: Date;
}

function trialContext(fields: TrialRunContextFields) {
  return {
    mode: 'trial' as const,
    sessionId: fields.sessionId,
    runId: fields.runId,
    fence: fields.fence,
  };
}

async function admitted(now: Date): Promise<boolean> {
  const result = await admitTrialSpend({ redis }, { now });
  return result._unsafeUnwrap().admitted;
}

async function seedSpend(amountNanoUsd: bigint, now: Date): Promise<void> {
  const result = await incrementTrialSpend({ redis }, { amountNanoUsd, now });
  result._unsafeUnwrap();
}

describe('trial settlement (no-persist / no-charge, post-commit spend fold)', () => {
  it('flips the key row, writes zero domain rows, and folds actual cost into the daily counter', async () => {
    const fields = await context(freshNow());
    const telemetry = telemetrySpy();
    const hook = createTrialSettlementHook(
      deps({ telemetry }),
      trialContext(fields),
      () => fields.now
    );
    await hook(request(fields.runKey, [charge(1000n)]));

    // The key row flipped — a resubmit replays rather than re-executes.
    const keyRows = await db
      .select()
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.id, fields.fence.id));
    expect(keyRows[0]?.status).toBe('succeeded');

    // No content, no charges: nothing saved, so nothing billed.
    expect(
      await db.select().from(messages).where(eq(messages.senderId, fields.sessionId))
    ).toHaveLength(0);
    expect(
      await db.select().from(usageRecords).where(eq(usageRecords.runId, fields.runId))
    ).toHaveLength(0);
    expect(
      await db.select().from(ledgerEntries).where(eq(ledgerEntries.transactionId, fields.runId))
    ).toHaveLength(0);
    expect(
      await db.select().from(contentItems).where(eq(contentItems.modelId, 'trial/model'))
    ).toHaveLength(0);

    // The post-commit fold landed on the shared daily counter (observed through
    // billing's published API): the $1000-nano run left it below the cap.
    const stored = await redis.get(counterKey(fields.now));
    expect(String(stored)).toBe('1000');
    expect(telemetry.warn).not.toHaveBeenCalled();
  });

  it('crosses the cap through the fold and fires exactly one alert', async () => {
    const fields = await context(freshNow());
    const telemetry = telemetrySpy();
    // Pre-seed the day to just below the cap through the same public counter.
    await seedSpend(TRIAL_DAILY_SPEND_CAP_NANO_USD - 500n, fields.now);
    expect(await admitted(fields.now)).toBe(true);

    const hook = createTrialSettlementHook(
      deps({ telemetry }),
      trialContext(fields),
      () => fields.now
    );
    await hook(request(fields.runKey, [charge(1000n)]));

    // The fold pushed the day over the cap: admission now refuses, and exactly
    // one content-free crossing alert fired.
    expect(await admitted(fields.now)).toBe(false);
    expect(telemetry.warn).toHaveBeenCalledTimes(1);
  });

  it('never fails a settled run when the post-commit increment is unavailable (best-effort)', async () => {
    const fields = await context(freshNow());
    const telemetry = telemetrySpy();
    // Real DB for the fenced settlement, a dead Redis for the post-commit fold.
    const hook = createTrialSettlementHook(
      deps({ redis: deadRedis, telemetry }),
      trialContext(fields),
      () => fields.now
    );

    await expect(hook(request(fields.runKey, [charge(1000n)]))).resolves.toBeUndefined();

    // The settlement still committed (key row flipped) despite the lost fold.
    const keyRows = await db
      .select()
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.id, fields.fence.id));
    expect(keyRows[0]?.status).toBe('succeeded');
    // A best-effort warning was logged; the run never threw.
    expect(telemetry.warn).toHaveBeenCalledTimes(1);
  });

  it('does not fold the daily counter when the fenced settlement loses its claim', async () => {
    const fields = await context(freshNow());
    const telemetry = telemetrySpy();
    // A superseding claimant reclaims the key row (bumps `claims`, takes
    // `claimedBy`), so the original executor's fence is stale — the real-DB
    // mirror of a lease-expired retry that makes the fenced flip report 'lost'.
    await db
      .update(idempotencyKeys)
      .set({ claims: fields.fence.claims + 1, claimedBy: crypto.randomUUID() })
      .where(eq(idempotencyKeys.id, fields.fence.id));

    const hook = createTrialSettlementHook(
      deps({ telemetry }),
      trialContext(fields),
      () => fields.now
    );

    // The fenced settlement throws, short-circuiting before the post-commit fold.
    await expect(hook(request(fields.runKey, [charge(1000n)]))).rejects.toBeInstanceOf(
      SettlementFenceLost
    );

    // The daily trial-spend counter was never touched, and no cap-crossed /
    // skipped alert fired — recordTrialSpend never ran.
    expect(await redis.get(counterKey(fields.now))).toBeNull();
    expect(telemetry.warn).not.toHaveBeenCalled();
  });
});
