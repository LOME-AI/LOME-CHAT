import { describe, expect, it } from 'vitest';
import { TRIAL_DAILY_SPEND_CAP_NANO_USD } from './constants.js';
import { admitTrialSpend, incrementTrialSpend } from './trial-spend.js';
import type { TrialSpendDeps } from './trial-spend.js';

/**
 * The daily cumulative trial-spend counter — billing's single-writer Redis
 * gate on aggregate free-trial provider spend. Admission is a read-and-compare
 * (no reservation); settlement folds each run's ACTUAL provider cost into the
 * counter and reports the one increment that crosses the cap.
 */

const NOW = new Date('2026-07-07T12:00:00Z');

/** A Redis whose GET resolves `stored` (the counter value or null). */
function redisWithCounter(stored: string | number | null): TrialSpendDeps['redis'] {
  return {
    get: () => Promise.resolve(stored),
  } as unknown as TrialSpendDeps['redis'];
}

const rejectingGetRedis = {
  get: () => Promise.reject(new Error('redis down')),
} as unknown as TrialSpendDeps['redis'];

/** A Redis whose increment script resolves `outcome`, capturing the exec args. */
function redisWithScript(
  outcome: string,
  captured?: { args?: readonly string[] }
): TrialSpendDeps['redis'] {
  return {
    createScript: () => ({
      exec: (_keys: string[], args: string[]) => {
        if (captured) captured.args = args;
        return Promise.resolve(outcome);
      },
    }),
  } as unknown as TrialSpendDeps['redis'];
}

const rejectingScriptRedis = {
  createScript: () => ({ exec: () => Promise.reject(new Error('redis down')) }),
} as unknown as TrialSpendDeps['redis'];

describe('admitTrialSpend', () => {
  it('admits when the counter is below the daily cap', async () => {
    const redis = redisWithCounter((TRIAL_DAILY_SPEND_CAP_NANO_USD - 1n).toString(10));
    const result = await admitTrialSpend({ redis }, { now: NOW });
    expect(result._unsafeUnwrap()).toEqual({ admitted: true });
  });

  it('admits when no counter exists yet for the day (treated as zero)', async () => {
    const result = await admitTrialSpend({ redis: redisWithCounter(null) }, { now: NOW });
    expect(result._unsafeUnwrap()).toEqual({ admitted: true });
  });

  it('refuses once the counter has reached the cap', async () => {
    const redis = redisWithCounter(TRIAL_DAILY_SPEND_CAP_NANO_USD.toString(10));
    const result = await admitTrialSpend({ redis }, { now: NOW });
    expect(result._unsafeUnwrap()).toEqual({ admitted: false });
  });

  it('fails closed (unavailable) when Redis is down', async () => {
    const result = await admitTrialSpend({ redis: rejectingGetRedis }, { now: NOW });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.code).toBe('unavailable');
  });

  it('fails closed (validation) when the stored counter is non-numeric', async () => {
    const result = await admitTrialSpend({ redis: redisWithCounter('not-a-number') }, { now: NOW });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.code).toBe('validation');
  });

  it('fails closed (validation) when the stored counter is negative', async () => {
    const result = await admitTrialSpend({ redis: redisWithCounter('-1') }, { now: NOW });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.code).toBe('validation');
  });
});

describe('incrementTrialSpend', () => {
  it('passes the amount to Redis as a decimal STRING (money never Number-coerced)', async () => {
    const captured: { args?: readonly string[] } = {};
    const redis = redisWithScript('below:1234', captured);
    const result = await incrementTrialSpend({ redis }, { amountNanoUsd: 1234n, now: NOW });
    expect(result.isOk()).toBe(true);
    expect(captured.args?.[0]).toBe('1234');
    expect(captured.args?.[1]).toBe(TRIAL_DAILY_SPEND_CAP_NANO_USD.toString(10));
  });

  it('reports a crossing with the new total as a bigint', async () => {
    const redis = redisWithScript(`crossed:${TRIAL_DAILY_SPEND_CAP_NANO_USD.toString(10)}`);
    const result = await incrementTrialSpend({ redis }, { amountNanoUsd: 10n, now: NOW });
    expect(result._unsafeUnwrap()).toEqual({
      crossed: true,
      total: TRIAL_DAILY_SPEND_CAP_NANO_USD,
    });
  });

  it('reports no crossing below the cap with the running total', async () => {
    const redis = redisWithScript('below:5000');
    const result = await incrementTrialSpend({ redis }, { amountNanoUsd: 5000n, now: NOW });
    expect(result._unsafeUnwrap()).toEqual({ crossed: false, total: 5000n });
  });

  it('fails closed (unavailable) on a malformed script outcome', async () => {
    const result = await incrementTrialSpend(
      { redis: redisWithScript('surprise') },
      { amountNanoUsd: 1n, now: NOW }
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.code).toBe('unavailable');
  });

  it('fails closed (unavailable) when Redis is down', async () => {
    const result = await incrementTrialSpend(
      { redis: rejectingScriptRedis },
      { amountNanoUsd: 1n, now: NOW }
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.code).toBe('unavailable');
  });

  it('keys the counter on the UTC day (a rollover starts a fresh hash)', async () => {
    const capturedKeys: { keys?: readonly string[] } = {};
    const redis = {
      createScript: () => ({
        exec: (keys: string[]) => {
          capturedKeys.keys = keys;
          return Promise.resolve('below:1');
        },
      }),
    } as unknown as TrialSpendDeps['redis'];
    const result = await incrementTrialSpend({ redis }, { amountNanoUsd: 1n, now: NOW });
    expect(result.isOk()).toBe(true);
    expect(capturedKeys.keys?.[0]).toBe('trial:global:spend:2026-07-07');
  });
});
