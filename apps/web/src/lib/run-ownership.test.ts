import { describe, it, expect, beforeEach } from 'vitest';
import {
  markPendingLocalRun,
  resolvePendingLocalRun,
  clearPendingLocalRun,
  releaseLocalRun,
  isLocalRun,
  resetRunOwnershipForTests,
} from '@/lib/run-ownership.js';

describe('run ownership', () => {
  beforeEach(() => {
    resetRunOwnershipForTests();
  });

  it('treats an unknown run as remote', () => {
    expect(isLocalRun('c1', 'r1')).toBe(false);
  });

  it('treats any run as local while a local POST is pending', () => {
    markPendingLocalRun('c1');
    expect(isLocalRun('c1', 'whatever')).toBe(true);
    expect(isLocalRun('c2', 'whatever')).toBe(false);
  });

  it('registers the resolved run id as local and clears the pending flag', () => {
    markPendingLocalRun('c1');
    resolvePendingLocalRun('c1', 'r1');
    expect(isLocalRun('c1', 'r1')).toBe(true);
    expect(isLocalRun('c1', 'other')).toBe(false);
  });

  it('clears the pending flag on POST failure', () => {
    markPendingLocalRun('c1');
    clearPendingLocalRun('c1');
    expect(isLocalRun('c1', 'anything')).toBe(false);
  });

  it('releases a local run when it finishes', () => {
    markPendingLocalRun('c1');
    resolvePendingLocalRun('c1', 'r1');
    releaseLocalRun('c1', 'r1');
    expect(isLocalRun('c1', 'r1')).toBe(false);
  });

  it('supports overlapping pending marks (counted)', () => {
    markPendingLocalRun('c1');
    markPendingLocalRun('c1');
    clearPendingLocalRun('c1');
    expect(isLocalRun('c1', 'x')).toBe(true);
    clearPendingLocalRun('c1');
    expect(isLocalRun('c1', 'x')).toBe(false);
  });
});
