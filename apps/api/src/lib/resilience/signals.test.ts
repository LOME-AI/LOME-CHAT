import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isDomainError } from '../errors/index.js';
import { anySignal, timeoutSignal } from './signals.js';

describe('timeoutSignal', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stays live before the deadline', () => {
    const { signal } = timeoutSignal(100);

    vi.advanceTimersByTime(99);

    expect(signal.aborted).toBe(false);
  });

  it('aborts once the deadline passes', () => {
    const { signal } = timeoutSignal(100);

    vi.advanceTimersByTime(100);

    expect(signal.aborted).toBe(true);
  });

  it('aborts with a timeout domain error as the reason', () => {
    const { signal } = timeoutSignal(100);

    vi.advanceTimersByTime(100);

    expect(isDomainError(signal.reason)).toBe(true);
    expect((signal.reason as { code: string }).code).toBe('timeout');
  });

  it('never aborts after dispose', () => {
    const { signal, dispose } = timeoutSignal(100);

    dispose();
    vi.advanceTimersByTime(1000);

    expect(signal.aborted).toBe(false);
  });
});

describe('anySignal', () => {
  it('aborts when any source aborts, propagating the reason', () => {
    const a = new AbortController();
    const b = new AbortController();
    const { signal } = anySignal([a.signal, b.signal]);

    b.abort('because');

    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe('because');
  });

  it('is aborted immediately when a source is already aborted', () => {
    const aborted = new AbortController();
    aborted.abort('pre-aborted');

    const { signal } = anySignal([aborted.signal]);

    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe('pre-aborted');
  });

  it('stays live while no source aborts', () => {
    const a = new AbortController();

    const { signal } = anySignal([a.signal]);

    expect(signal.aborted).toBe(false);
  });

  it('detaches from sources on dispose', () => {
    const a = new AbortController();
    const { signal, dispose } = anySignal([a.signal]);

    dispose();
    a.abort('too late');

    expect(signal.aborted).toBe(false);
  });
});
