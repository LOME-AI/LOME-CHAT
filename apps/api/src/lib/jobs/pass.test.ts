import { describe, expect, it } from 'vitest';
import { MIN_REARM_DELAY_MS, createJobExecutor, rearmDelayMs } from './pass.js';
import { createJobRegistry } from './registry.js';
import type { Database } from '@hushbox/db';
import type { Telemetry } from '../telemetry/index.js';

const silentTelemetry: Telemetry = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  emitMetric: () => {},
  captureError: () => {},
};

/**
 * A no-op query surface for a pass over an EMPTY shard: the sweep,
 * dead-letter, and claim statements each resolve to no rows (an empty candidate
 * subquery makes the claim's `inArray` a `false` predicate), and the
 * re-arm-advice query returns the given `delay_seconds`. This lets the unit
 * suite exercise the shard-global advice mapping (`idle` vs the exact
 * `scheduled` delay) against a controlled DB with no foreign rows — the property
 * the shared-`default`-shard integration suite cannot observe stably.
 */
function emptyShardDb(delaySeconds: string | number | null): Database {
  const noRows = (): Promise<never[]> => Promise.resolve([]);
  const writeBuilder = {
    set: () => writeBuilder,
    where: () => writeBuilder,
    returning: noRows,
  };
  const selectBuilder = {
    from: () => selectBuilder,
    where: () => selectBuilder,
    orderBy: () => selectBuilder,
    limit: () => selectBuilder,
    // The candidate subquery: an empty array makes claim's `inArray(...)` a
    // `false` predicate rather than touching a real database.
    for: (): never[] => [],
  };
  return {
    update: () => writeBuilder,
    select: () => selectBuilder,
    execute: () => Promise.resolve({ rows: [{ delay_seconds: delaySeconds }] }),
  } as unknown as Database;
}

function advisoryExecutor(
  delaySeconds: string | number | null
): ReturnType<typeof createJobExecutor> {
  return createJobExecutor({
    withDb: (use) => use(emptyShardDb(delaySeconds)),
    registry: createJobRegistry(),
    telemetry: silentTelemetry,
    claimantId: 'claimant-test',
    random: () => 0.5,
    now: () => Date.now(),
    passBudgetMs: 60_000,
  });
}

describe('createJobExecutor.runPass re-arm advice', () => {
  it('returns idle when the shard has no pending or scheduled work', async () => {
    expect(await advisoryExecutor(null).runPass('default')).toEqual({ kind: 'idle' });
  });

  it('advises the exact delay Postgres computed for future-scheduled work', async () => {
    expect(await advisoryExecutor(45).runPass('default')).toEqual({
      kind: 'scheduled',
      delayMs: 45_000,
    });
  });
});

describe('rearmDelayMs', () => {
  it('returns undefined when Postgres found no schedulable work', () => {
    expect(rearmDelayMs(null)).toBeUndefined();
    expect(rearmDelayMs()).toBeUndefined();
  });

  it('converts interval seconds to milliseconds', () => {
    expect(rearmDelayMs('2.5')).toBe(2500);
  });

  it('accepts a numeric driver value', () => {
    expect(rearmDelayMs(4)).toBe(4000);
  });

  it('floors tiny delays at 250ms', () => {
    expect(rearmDelayMs(0.1)).toBe(MIN_REARM_DELAY_MS);
  });

  it('floors already-due (negative) delays at 250ms', () => {
    expect(rearmDelayMs('-3')).toBe(MIN_REARM_DELAY_MS);
  });

  it('rejects a non-numeric value from the driver', () => {
    expect(() => rearmDelayMs('not-a-number')).toThrow('re-arm');
  });
});

describe('createJobExecutor.runPass', () => {
  it('rejects an unknown shard name before touching the database', async () => {
    const executor = createJobExecutor({
      withDb: () => {
        throw new Error('database must not be touched for an invalid shard');
      },
      registry: createJobRegistry(),
      telemetry: silentTelemetry,
      claimantId: 'claimant-test',
      random: () => 0.5,
      now: () => Date.now(),
      passBudgetMs: 1000,
    });
    await expect(executor.runPass('fast')).rejects.toThrow('shard');
  });
});
