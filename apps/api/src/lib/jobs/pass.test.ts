import { describe, expect, it } from 'vitest';
import { MIN_REARM_DELAY_MS, createJobExecutor, rearmDelayMs } from './pass.js';
import { createJobRegistry } from './registry.js';
import type { Telemetry } from '../telemetry/index.js';

const silentTelemetry: Telemetry = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  emitMetric: () => {},
  captureError: () => {},
};

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
