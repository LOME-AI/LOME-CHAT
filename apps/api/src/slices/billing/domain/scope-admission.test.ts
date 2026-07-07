import { describe, expect, it } from 'vitest';
import { admitScope } from './scope-admission.js';
import type { ScopeAdmissionDeps, ScopeAdmissionRequest } from './scope-admission.js';

/** A Redis whose script exec resolves an outcome the script never returns. */
function redisReturning(outcome: string): ScopeAdmissionDeps['redis'] {
  return {
    createScript: () => ({ exec: () => Promise.resolve(outcome) }),
  } as unknown as ScopeAdmissionDeps['redis'];
}

const request: ScopeAdmissionRequest = {
  scopeId: 'trial:global:2026-07-05',
  holdId: 'hold-1',
  estimateNanoUsd: 1n,
  remainingNanoUsd: 10n,
  deadlineSeconds: 300,
  now: new Date('2026-07-05T00:00:00Z'),
};

describe('admitScope (defensive)', () => {
  it('fails closed when the script returns an unrecognized outcome', async () => {
    const result = await admitScope({ redis: redisReturning('surprise') }, request);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.code).toBe('unavailable');
  });
});
