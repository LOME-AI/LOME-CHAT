import { afterAll, describe, expect, it } from 'vitest';
import { Redis } from '@upstash/redis';
import { BILLING_KEYS } from './keys.js';
import { admitScope, trialGlobalScopeId } from './scope-admission.js';
import type { ScopeAdmissionDecision, ScopeAdmissionRequest } from './scope-admission.js';

/**
 * The scope-only admission check: the trial policy's global Sybil budget rides
 * one period-keyed scope holds hash with NO wallet, snapshot, balance, or
 * run-cap leg. It reserves a run's estimate against the shared budget and
 * refuses once the sum of active holds would exceed it — bounding aggregate
 * concurrent trial provider exposure.
 */

const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error(
    'UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required for scope-admission tests'
  );
}

const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });
const deadRedis = new Redis({ url: 'http://localhost:1', token: 'token' });
const NOW = new Date('2026-07-05T12:00:00Z');
const createdScopeIds: string[] = [];

/** A unique scope per test so parallel runs never share a holds hash. */
function freshScopeId(): string {
  const id = `trial:global:test:${crypto.randomUUID()}`;
  createdScopeIds.push(id);
  return id;
}

function request(
  scopeId: string,
  overrides?: Partial<ScopeAdmissionRequest>
): ScopeAdmissionRequest {
  return {
    scopeId,
    holdId: crypto.randomUUID(),
    estimateNanoUsd: 100_000_000n,
    remainingNanoUsd: 1_000_000_000n,
    deadlineSeconds: 300,
    now: NOW,
    ...overrides,
  };
}

afterAll(async () => {
  if (createdScopeIds.length > 0) {
    await Promise.all(
      createdScopeIds.map((scopeId) => redis.del(BILLING_KEYS.scopeHolds.buildKey(scopeId)))
    );
  }
});

async function admit(req: ScopeAdmissionRequest): Promise<ScopeAdmissionDecision> {
  const result = await admitScope({ redis }, req);
  return result._unsafeUnwrap();
}

describe('admitScope', () => {
  it('admits a run that fits the scope budget and returns the hold id', async () => {
    const scopeId = freshScopeId();
    const req = request(scopeId);
    const decision = await admit(req);
    expect(decision.admitted).toBe(true);
    if (!decision.admitted) throw new Error('unreachable');
    expect(decision.holdId).toBe(req.holdId);
  });

  it('sums active holds so the budget cannot be jointly over-committed', async () => {
    const scopeId = freshScopeId();
    // Budget 250; two prior 100-holds leave 50 remaining, so a third 100 refuses.
    const remainingNanoUsd = 250_000_000n;
    const first = await admit(request(scopeId, { remainingNanoUsd }));
    const second = await admit(request(scopeId, { remainingNanoUsd }));
    const third = await admit(request(scopeId, { remainingNanoUsd }));
    expect(first.admitted).toBe(true);
    expect(second.admitted).toBe(true);
    expect(third.admitted).toBe(false);
  });

  it('lazily prunes an expired hold so its budget is freed', async () => {
    const scopeId = freshScopeId();
    const remainingNanoUsd = 100_000_000n;
    // A hold placed 10 minutes ago has already expired by NOW (its lifetime is
    // deadline + margin, well under 10 minutes for the text deadline class).
    const stale = new Date(NOW.getTime() - 10 * 60 * 1000);
    const staleAdmit = await admit(
      request(scopeId, { remainingNanoUsd, now: stale, deadlineSeconds: 60 })
    );
    expect(staleAdmit.admitted).toBe(true);
    // At NOW the stale hold is pruned, so the full budget is available again.
    const fresh = await admit(request(scopeId, { remainingNanoUsd }));
    expect(fresh.admitted).toBe(true);
  });

  it('fails closed (unavailable) when Redis is down', async () => {
    const scopeId = freshScopeId();
    const result = await admitScope({ redis: deadRedis }, request(scopeId));
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.code).toBe('unavailable');
  });
});

describe('trialGlobalScopeId', () => {
  it('keys the scope on the UTC day so a rollover starts a fresh hash', () => {
    expect(trialGlobalScopeId(NOW)).toBe('trial:global:2026-07-05');
  });
});
