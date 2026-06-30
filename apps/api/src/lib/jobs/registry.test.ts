import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { jobOutcome } from './outcome.js';
import { createJobRegistry } from './registry.js';
import type { JobRegistration } from './registry.js';

const payloadSchema = z.object({ userId: z.string() });

function validRegistration(): JobRegistration<typeof payloadSchema> {
  return {
    type: 'export.build.v1',
    schema: payloadSchema,
    leaseSeconds: 900,
    maxFailures: 5,
    idempotency: 'txn',
    handler: () => Promise.resolve(jobOutcome.ok()),
  };
}

describe('createJobRegistry', () => {
  it('returns a registered type with registry-derived claim budget', () => {
    const registry = createJobRegistry();
    registry.register(validRegistration());
    const registered = registry.get('export.build.v1');
    expect(registered).toMatchObject({
      type: 'export.build.v1',
      leaseSeconds: 900,
      maxFailures: 5,
      maxClaims: 8,
      idempotency: 'txn',
      shard: 'default',
    });
  });

  it('returns undefined for an unregistered type', () => {
    const registry = createJobRegistry();
    expect(registry.get('missing.v1')).toBeUndefined();
  });

  it('honors an explicit shard declaration', () => {
    const registry = createJobRegistry();
    registry.register({ ...validRegistration(), shard: 'bulk' });
    expect(registry.get('export.build.v1')?.shard).toBe('bulk');
  });

  it('lists registered types', () => {
    const registry = createJobRegistry();
    registry.register(validRegistration());
    expect(registry.types()).toEqual(['export.build.v1']);
  });

  it('rejects a duplicate type registration', () => {
    const registry = createJobRegistry();
    registry.register(validRegistration());
    expect(() => {
      registry.register(validRegistration());
    }).toThrow('already registered');
  });

  it('rejects an unversioned type name', () => {
    const registry = createJobRegistry();
    expect(() => {
      registry.register({ ...validRegistration(), type: 'export.build' });
    }).toThrow('versioned');
  });

  it('rejects a missing payload schema', () => {
    const registry = createJobRegistry();
    const registration = { ...validRegistration(), schema: undefined } as unknown as ReturnType<
      typeof validRegistration
    >;
    expect(() => {
      registry.register(registration);
    }).toThrow('schema');
  });

  it('rejects a non-positive leaseSeconds', () => {
    const registry = createJobRegistry();
    expect(() => {
      registry.register({ ...validRegistration(), leaseSeconds: 0 });
    }).toThrow('leaseSeconds');
  });

  it('rejects a leaseSeconds above the fifteen-minute alarm wall', () => {
    const registry = createJobRegistry();
    expect(() => {
      registry.register({ ...validRegistration(), leaseSeconds: 901 });
    }).toThrow('leaseSeconds');
  });

  it('rejects a fractional maxFailures', () => {
    const registry = createJobRegistry();
    expect(() => {
      registry.register({ ...validRegistration(), maxFailures: 2.5 });
    }).toThrow('maxFailures');
  });

  it('rejects an unknown idempotency class', () => {
    const registry = createJobRegistry();
    const registration = {
      ...validRegistration(),
      idempotency: 'maybe',
    } as unknown as ReturnType<typeof validRegistration>;
    expect(() => {
      registry.register(registration);
    }).toThrow('idempotency');
  });

  it('rejects a missing handler', () => {
    const registry = createJobRegistry();
    const registration = { ...validRegistration(), handler: undefined } as unknown as ReturnType<
      typeof validRegistration
    >;
    expect(() => {
      registry.register(registration);
    }).toThrow('handler');
  });

  it('rejects an unknown shard', () => {
    const registry = createJobRegistry();
    const registration = { ...validRegistration(), shard: 'fast' } as unknown as ReturnType<
      typeof validRegistration
    >;
    expect(() => {
      registry.register(registration);
    }).toThrow('shard');
  });
});

describe('jobOutcome', () => {
  it('builds an ok outcome with a null default result', () => {
    expect(jobOutcome.ok()).toEqual({ kind: 'ok', result: null });
  });

  it('builds an ok outcome carrying its result', () => {
    expect(jobOutcome.ok({ exported: 3 })).toEqual({ kind: 'ok', result: { exported: 3 } });
  });

  it('builds a fail outcome', () => {
    expect(jobOutcome.fail('gateway-5xx')).toEqual({ kind: 'fail', error: 'gateway-5xx' });
  });

  it('builds a yield outcome carrying its checkpoint', () => {
    expect(jobOutcome.yield({ cursor: 'abc' })).toEqual({
      kind: 'yield',
      checkpoint: { cursor: 'abc' },
    });
  });

  it('builds a dead outcome', () => {
    expect(jobOutcome.dead('payload-unparseable')).toEqual({
      kind: 'dead',
      error: 'payload-unparseable',
    });
  });
});
