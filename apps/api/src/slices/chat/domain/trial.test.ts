import { describe, expect, it } from 'vitest';
import {
  createTrialAdmissionHook,
  createTrialSettlementCommit,
  requireTrialContext,
} from './trial.js';
import { COST_CIRCUIT_MULTIPLIER } from '../../billing/index.js';
import type { TrialHookDeps, TrialRunContext } from './trial.js';
import type { AdmissionRequest, WorkflowDefinition } from '@hushbox/shared';

const DEFINITION = { deadlineClass: 'text' } as unknown as WorkflowDefinition;

const CONTEXT: TrialRunContext = {
  mode: 'trial',
  sessionId: 's1',
  runId: 'run-1',
  fence: { id: 'f', executorId: 'e', claims: 1 },
};

const REQUEST = { definition: DEFINITION, estimate: 100n } as unknown as AdmissionRequest;

/** A fake Redis whose scope-admission script resolves the given outcome. */
function redisReturning(outcome: string): TrialHookDeps['redis'] {
  return {
    createScript: () => ({ exec: () => Promise.resolve(outcome) }),
  } as unknown as TrialHookDeps['redis'];
}

const rejectingRedis = {
  createScript: () => ({ exec: () => Promise.reject(new Error('redis down')) }),
} as unknown as TrialHookDeps['redis'];

function deps(redis: TrialHookDeps['redis']): TrialHookDeps {
  return { redis, db: {} as unknown as TrialHookDeps['db'] };
}

const clock = (): Date => new Date('2026-07-05T12:00:00Z');

describe('createTrialAdmissionHook', () => {
  it('grants against the global scope and supplies the cost-circuit readout (no wallet hold)', async () => {
    const hook = createTrialAdmissionHook(
      deps(redisReturning('admitted')),
      CONTEXT,
      DEFINITION,
      clock
    );
    const decision = await hook(REQUEST);
    expect(decision).toEqual({
      admitted: true,
      holdRef: 'run-1',
      circuit: {
        estimateNanoUsd: 100n,
        costCircuitMultiplier: COST_CIRCUIT_MULTIPLIER,
        costCircuitLimitNanoUsd: 100n * COST_CIRCUIT_MULTIPLIER,
      },
    });
  });

  it('refuses when the global Sybil budget is exhausted', async () => {
    const hook = createTrialAdmissionHook(
      deps(redisReturning('budget-exceeded')),
      CONTEXT,
      DEFINITION,
      clock
    );
    const decision = await hook(REQUEST);
    expect(decision).toEqual({ admitted: false, code: 'INSUFFICIENT_ADMISSION' });
  });

  it('fails closed to ADMISSION_UNAVAILABLE when Redis is down', async () => {
    const hook = createTrialAdmissionHook(deps(rejectingRedis), CONTEXT, DEFINITION, clock);
    const decision = await hook(REQUEST);
    expect(decision).toEqual({ admitted: false, code: 'ADMISSION_UNAVAILABLE' });
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
