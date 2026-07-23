import { describe, it, expect, vi, afterEach } from 'vitest';
import os from 'node:os';

import { CI_WORKER_COUNT, E2E_WORKER_POOL_SIZE, resolveLocalWorkerCount } from './worker-count.js';

type Cpu = ReturnType<typeof os.cpus>[number];

function cpu(model: string): Cpu {
  return { model, speed: 1, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } };
}

function mockCpuModel(model: string | undefined, cores = 24): void {
  vi.spyOn(os, 'cpus').mockReturnValue(model === undefined ? [] : [cpu(model)]);
  vi.spyOn(os, 'availableParallelism').mockReturnValue(cores);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveLocalWorkerCount', () => {
  it('returns the registry value for a model matching the 285K key', () => {
    mockCpuModel('Intel(R) Core(TM) Ultra 9 285K', 24);
    expect(resolveLocalWorkerCount()).toBe(12);
  });

  it('returns the registry value for a model matching the 13900H key', () => {
    mockCpuModel('13th Gen Intel(R) Core(TM) i9-13900H', 24);
    expect(resolveLocalWorkerCount()).toBe(10);
  });

  it('does not match a desktop i9-13900K and falls back to the 50% default', () => {
    // The mobile 13900H is registered; the desktop 13900K is a different part
    // and must fall through to the core-relative default, not the 13900H row.
    mockCpuModel('13th Gen Intel(R) Core(TM) i9-13900K', 24);
    expect(resolveLocalWorkerCount()).toBe(Math.round(0.5 * 24));
  });

  it('falls back to 50% of logical cores for an unknown model', () => {
    // round(0.5 * 20) = 10
    mockCpuModel('AMD Ryzen 9 7950X 16-Core Processor', 20);
    expect(resolveLocalWorkerCount()).toBe(10);
  });

  it('rounds the 50% fallback to the nearest integer', () => {
    // round(0.5 * 21) = round(10.5) = 11
    mockCpuModel('AMD Ryzen 9 7950X 16-Core Processor', 21);
    expect(resolveLocalWorkerCount()).toBe(11);
  });

  it('falls back to the 50% default when no CPU model is available', () => {
    // round(0.5 * 20) = 10
    mockCpuModel(undefined, 20);
    expect(resolveLocalWorkerCount()).toBe(10);
  });

  it('returns 1 on a single-core machine', () => {
    // round(0.5 * 1) = round(0.5) = 1
    mockCpuModel('AMD Ryzen 9 7950X 16-Core Processor', 1);
    expect(resolveLocalWorkerCount()).toBe(1);
  });

  it('matches registry keys case-insensitively', () => {
    mockCpuModel('some vendor core ultra 9 285k cpu', 24);
    expect(resolveLocalWorkerCount()).toBe(12);
  });

  it('clamps a registry value to the machine logical core count', () => {
    // registry says 12 for 285K, but the machine only has 8 logical cores
    mockCpuModel('Intel(R) Core(TM) Ultra 9 285K', 8);
    expect(resolveLocalWorkerCount()).toBe(8);
  });
});

describe('E2E_WORKER_POOL_SIZE', () => {
  it('is the max of the resolved local worker count and CI worker count', () => {
    // Computed at import against the real machine; recompute it the same way.
    expect(E2E_WORKER_POOL_SIZE).toBe(Math.max(resolveLocalWorkerCount(), CI_WORKER_COUNT));
  });

  it('is at least the CI worker count', () => {
    expect(E2E_WORKER_POOL_SIZE).toBeGreaterThanOrEqual(CI_WORKER_COUNT);
  });

  it('covers the workers that actually run locally', () => {
    // The core invariant the pool exists to guarantee: workers ≤ pool.
    expect(E2E_WORKER_POOL_SIZE).toBeGreaterThanOrEqual(resolveLocalWorkerCount());
  });
});
