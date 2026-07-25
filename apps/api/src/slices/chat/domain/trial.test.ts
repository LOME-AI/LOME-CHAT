import { describe, expect, it, vi } from 'vitest';
import { TRIAL_DAILY_SPEND_CAP_NANO_USD } from '../../billing/index.js';
import {
  bindTrialHooks,
  createTrialAdmissionHook,
  createTrialSettlementCommit,
  recordTrialSpend,
  requireTrialContext,
} from './trial.js';
import { COST_CIRCUIT_MULTIPLIER } from '../../billing/index.js';
import type { TrialHookDeps, TrialRunContext } from './trial.js';
import type { Telemetry } from '../../../lib/telemetry/index.js';
import type { AdmissionRequest, SettlementCharge } from '@hushbox/shared';

const CONTEXT: TrialRunContext = {
  mode: 'trial',
  sessionId: 's1',
  runId: 'run-1',
  fence: { id: 'f', executorId: 'e', claims: 1 },
};

const REQUEST = { estimate: 100n } as unknown as AdmissionRequest;
const clock = (): Date => new Date('2026-07-07T12:00:00Z');

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

/** A Redis whose GET (the admission read) resolves the given counter value. */
function redisWithCounter(stored: string | number | null): TrialHookDeps['redis'] {
  return { get: () => Promise.resolve(stored) } as unknown as TrialHookDeps['redis'];
}

const rejectingGetRedis = {
  get: () => Promise.reject(new Error('redis down')),
} as unknown as TrialHookDeps['redis'];

/** A Redis whose increment script resolves the given outcome, capturing exec args. */
function redisWithScript(
  outcome: string,
  captured?: { args?: readonly string[] }
): TrialHookDeps['redis'] {
  return {
    createScript: () => ({
      exec: (_keys: string[], args: string[]) => {
        if (captured) captured.args = args;
        return Promise.resolve(outcome);
      },
    }),
  } as unknown as TrialHookDeps['redis'];
}

const rejectingScriptRedis = {
  createScript: () => ({ exec: () => Promise.reject(new Error('redis down')) }),
} as unknown as TrialHookDeps['redis'];

function deps(redis: TrialHookDeps['redis'], telemetry: Telemetry = telemetrySpy()): TrialHookDeps {
  return { redis, db: {} as unknown as TrialHookDeps['db'], telemetry };
}

function charge(billableCostNanoUsd: bigint): SettlementCharge {
  return {
    key: 'answer',
    modelId: 'trial/model',
    providerName: 'trial-provider',
    modality: 'text',
    billableCostNanoUsd,
    isEstimated: false,
  };
}

describe('createTrialAdmissionHook', () => {
  it('admits below the daily cap and supplies the cost-circuit readout (no wallet hold)', async () => {
    const redis = redisWithCounter((TRIAL_DAILY_SPEND_CAP_NANO_USD - 1n).toString(10));
    const hook = createTrialAdmissionHook(deps(redis), CONTEXT, clock);
    expect(await hook(REQUEST)).toEqual({
      admitted: true,
      holdRef: 'run-1',
      circuit: {
        estimateNanoUsd: 100n,
        costCircuitMultiplier: COST_CIRCUIT_MULTIPLIER,
        costCircuitLimitNanoUsd: 100n * COST_CIRCUIT_MULTIPLIER,
      },
    });
  });

  it('refuses with TRIAL_CAPACITY_REACHED once the daily cap is reached', async () => {
    const redis = redisWithCounter(TRIAL_DAILY_SPEND_CAP_NANO_USD.toString(10));
    const hook = createTrialAdmissionHook(deps(redis), CONTEXT, clock);
    expect(await hook(REQUEST)).toEqual({ admitted: false, code: 'TRIAL_CAPACITY_REACHED' });
  });

  it('fails closed to ADMISSION_UNAVAILABLE when Redis is down', async () => {
    const hook = createTrialAdmissionHook(deps(rejectingGetRedis), CONTEXT, clock);
    expect(await hook(REQUEST)).toEqual({ admitted: false, code: 'ADMISSION_UNAVAILABLE' });
  });

  it('emits no telemetry on a capacity refusal (a post-cap request must not flood alerts)', async () => {
    const telemetry = telemetrySpy();
    const redis = redisWithCounter(TRIAL_DAILY_SPEND_CAP_NANO_USD.toString(10));
    const hook = createTrialAdmissionHook(deps(redis, telemetry), CONTEXT, clock);
    await hook(REQUEST);
    expect(telemetry.warn).not.toHaveBeenCalled();
    expect(telemetry.captureError).not.toHaveBeenCalled();
  });
});

describe('recordTrialSpend', () => {
  it('folds the run’s actual provider cost (Σ base cost) into the counter as a decimal string', async () => {
    const captured: { args?: readonly string[] } = {};
    const redis = redisWithScript('below:900', captured);
    await recordTrialSpend(deps(redis), clock(), [charge(400n), charge(500n)]);
    expect(captured.args?.[0]).toBe('900');
  });

  it('fires exactly ONE content-free warning when the run crosses the cap', async () => {
    const telemetry = telemetrySpy();
    const redis = redisWithScript(`crossed:${TRIAL_DAILY_SPEND_CAP_NANO_USD.toString(10)}`);
    await recordTrialSpend(deps(redis, telemetry), clock(), [charge(20n)]);
    expect(telemetry.warn).toHaveBeenCalledTimes(1);
    const [, fields] = (telemetry.warn as unknown as ReturnType<typeof vi.fn>).mock.calls[0] ?? [];
    // Content-free: only the sanctioned observability money dimension, no
    // message/prompt/content/user field is representable or present.
    expect(Object.keys(fields ?? {})).toEqual(['costUsd']);
    expect(fields.costUsd).toBe(50);
  });

  it('pages Sentry with exactly ONE content-free captureError when the cap is crossed', async () => {
    const telemetry = telemetrySpy();
    const redis = redisWithScript(`crossed:${TRIAL_DAILY_SPEND_CAP_NANO_USD.toString(10)}`);
    await recordTrialSpend(deps(redis, telemetry), clock(), [charge(20n)]);
    // Only captureError feeds Sentry; the warn alone is Workers-Logs-only.
    expect(telemetry.captureError).toHaveBeenCalledTimes(1);
    const [error, code] =
      (telemetry.captureError as unknown as ReturnType<typeof vi.fn>).mock.calls[0] ?? [];
    expect(error).toBeInstanceOf(Error);
    // Content-free literal message + a stable fingerprint code; no amount or PII.
    expect(error.message).toBe('trial daily spend cap crossed');
    expect(code).toBe('trial_daily_cap_crossed');
  });

  it('fires no warning and no Sentry page when the increment stays below the cap', async () => {
    const telemetry = telemetrySpy();
    await recordTrialSpend(deps(redisWithScript('below:5000'), telemetry), clock(), [
      charge(5000n),
    ]);
    expect(telemetry.warn).not.toHaveBeenCalled();
    expect(telemetry.captureError).not.toHaveBeenCalled();
  });

  it('does not re-page when a later run in the same period does not re-cross', async () => {
    // Once-only is the `crossed` gate: after the crossing increment, subsequent
    // increments report `below:*`, so no second warn and no second page fire.
    const telemetry = telemetrySpy();
    await recordTrialSpend(deps(redisWithScript('below:6000'), telemetry), clock(), [
      charge(1000n),
    ]);
    expect(telemetry.warn).not.toHaveBeenCalled();
    expect(telemetry.captureError).not.toHaveBeenCalled();
  });

  it('swallows a Redis failure (best-effort — a settled run is never failed)', async () => {
    const telemetry = telemetrySpy();
    await expect(
      recordTrialSpend(deps(rejectingScriptRedis, telemetry), clock(), [charge(10n)])
    ).resolves.toBeUndefined();
    // A best-effort warning, never the cap-crossed alert or a Sentry page.
    expect(telemetry.warn).toHaveBeenCalledTimes(1);
    expect((telemetry.warn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).not.toBe(
      'trial daily spend cap crossed'
    );
    expect(telemetry.captureError).not.toHaveBeenCalled();
  });

  it('does not touch Redis or alert when the run produced no billable cost', async () => {
    const telemetry = telemetrySpy();
    const createScript = vi.fn();
    const redis = { createScript } as unknown as TrialHookDeps['redis'];
    await recordTrialSpend(deps(redis, telemetry), clock(), []);
    expect(createScript).not.toHaveBeenCalled();
    expect(telemetry.warn).not.toHaveBeenCalled();
  });
});

describe('bindTrialHooks', () => {
  it('binds the daily-spend admission and the fenced no-op settlement', () => {
    const hooks = bindTrialHooks(deps(redisWithCounter(null)), CONTEXT, clock);
    expect(typeof hooks.admission).toBe('function');
    expect(typeof hooks.settlement).toBe('function');
  });
});

describe('createTrialSettlementCommit', () => {
  it('is a no-op commit (persists nothing, charges nothing)', async () => {
    const commit = createTrialSettlementCommit();
    await expect(
      commit({} as never, { runKey: 'k', outputs: {}, charges: [] } as never)
    ).resolves.toBeUndefined();
  });
});

describe('requireTrialContext', () => {
  it('returns a trial context unchanged', () => {
    expect(requireTrialContext(CONTEXT)).toBe(CONTEXT);
  });

  it('throws when the identity is not trial', () => {
    const paid = {
      mode: 'paid',
      userId: 'u1',
      senderId: 'u1',
      conversationId: 'c1',
      walletId: 'w1',
      epochNumber: 1,
      userMessage: { id: 'um1', content: 'hi' },
      runId: 'run-1',
      fence: { id: 'f', executorId: 'e', claims: 1 },
    } as const;
    expect(() => requireTrialContext(paid)).toThrow(/trial run identity/);
  });
});
