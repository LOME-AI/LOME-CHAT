import { describe, expect, it } from 'vitest';
import { auditToWire, jobToWire } from './customer-360.js';

describe('jobToWire', () => {
  const base = {
    id: 'job-1',
    type: 'test.noop.v1',
    shard: 'bulk',
    status: 'dead',
    discarded: false,
    failures: 5,
    claims: 5,
    payload: { userId: 'u1' },
    errors: [{ at: '2026-07-14T00:00:00.000Z', claim: 5, error: 'boom' }],
    nextAttemptAt: new Date('2026-07-14T01:00:00Z'),
    createdAt: new Date('2026-07-14T00:00:00Z'),
    finishedAt: null,
  };

  it('serializes dates to ISO strings and keeps a null finishedAt', () => {
    const wire = jobToWire(base);
    expect(wire.nextAttemptAt).toBe('2026-07-14T01:00:00.000Z');
    expect(wire.createdAt).toBe('2026-07-14T00:00:00.000Z');
    expect(wire.finishedAt).toBeNull();
  });

  it('serializes a finished timestamp when present', () => {
    const wire = jobToWire({ ...base, finishedAt: new Date('2026-07-14T02:00:00Z') });
    expect(wire.finishedAt).toBe('2026-07-14T02:00:00.000Z');
  });
});

describe('auditToWire', () => {
  it('serializes createdAt and preserves the threading fields', () => {
    const wire = auditToWire({
      id: 'a1',
      actor: 'admin@hushbox.ai',
      action: 'wallet.credit',
      targetType: 'wallet',
      targetId: 'w1',
      details: { input: {} },
      undoes: null,
      undoneBy: 'a2',
      createdAt: new Date('2026-07-14T03:00:00Z'),
    });
    expect(wire).toMatchObject({ createdAt: '2026-07-14T03:00:00.000Z', undoneBy: 'a2' });
  });
});
