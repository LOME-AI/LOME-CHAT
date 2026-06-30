import { describe, expect, it } from 'vitest';
import {
  IDEMPOTENCY_TTL_CONFIG,
  REQUEST_LEASE_SECONDS,
  RUN_LEASE_SECONDS,
  assertIdempotencyTtlFloor,
} from './config.js';

const VALID = {
  purgeTtlSeconds: 7 * 24 * 3600,
  leaseSecondsByKind: { request: 90, run: 90 },
  maxRunDeadlineSeconds: 15 * 60,
  graceSeconds: 60,
  maxAutoResubmitHorizonSeconds: 10 * 60,
};

describe('assertIdempotencyTtlFloor', () => {
  it('accepts a purge TTL above every floor', () => {
    expect(() => {
      assertIdempotencyTtlFloor(VALID);
    }).not.toThrow();
  });

  it('rejects a purge TTL at or below the longest lease', () => {
    expect(() => {
      assertIdempotencyTtlFloor({ ...VALID, purgeTtlSeconds: 90 });
    }).toThrow(/purge TTL/);
  });

  it('rejects a purge TTL at or below deadline + grace + resubmit horizon', () => {
    expect(() => {
      assertIdempotencyTtlFloor({ ...VALID, purgeTtlSeconds: 15 * 60 + 60 + 10 * 60 });
    }).toThrow(/purge TTL/);
  });

  it('rejects non-positive configuration values', () => {
    expect(() => {
      assertIdempotencyTtlFloor({ ...VALID, graceSeconds: 0 });
    }).toThrow(/positive/);
    expect(() => {
      assertIdempotencyTtlFloor({
        ...VALID,
        leaseSecondsByKind: { request: -1, run: 90 },
      });
    }).toThrow(/positive/);
  });
});

describe('shipped configuration', () => {
  it('passes its own floor assertion', () => {
    expect(() => {
      assertIdempotencyTtlFloor(IDEMPOTENCY_TTL_CONFIG);
    }).not.toThrow();
  });

  it('exposes the per-kind leases it asserts over', () => {
    expect(IDEMPOTENCY_TTL_CONFIG.leaseSecondsByKind.request).toBe(REQUEST_LEASE_SECONDS);
    expect(IDEMPOTENCY_TTL_CONFIG.leaseSecondsByKind.run).toBe(RUN_LEASE_SECONDS);
  });
});
