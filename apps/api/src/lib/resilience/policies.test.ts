import { afterEach, describe, expect, it, vi } from 'vitest';
import { validationError } from '../errors/index.js';
import { retryPolicy, retryWithTimeoutPolicy, timeoutPolicy } from './policies.js';

const FAST_RETRY = { maxRetries: 2, initialDelayMs: 1, maxDelayMs: 2 };

afterEach(() => {
  vi.useRealTimers();
});

describe('retryPolicy', () => {
  it('resolves ok on first success without retrying', async () => {
    const task = vi.fn().mockResolvedValue('value');

    const result = await retryPolicy(FAST_RETRY).run(task);

    expect(result._unsafeUnwrap()).toBe('value');
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('retries until a later attempt succeeds', async () => {
    const task = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom 1'))
      .mockRejectedValueOnce(new Error('boom 2'))
      .mockResolvedValue('finally');

    const result = await retryPolicy(FAST_RETRY).run(task);

    expect(result._unsafeUnwrap()).toBe('finally');
    expect(task).toHaveBeenCalledTimes(3);
  });

  it('runs the task exactly maxRetries + 1 times before giving up', async () => {
    const task = vi.fn().mockRejectedValue(new Error('boom'));

    const result = await retryPolicy(FAST_RETRY).run(task);

    expect(result.isErr()).toBe(true);
    expect(task).toHaveBeenCalledTimes(3);
  });

  it('maps an unknown failure to an unavailable error carrying the cause', async () => {
    const failure = new Error('boom');
    const task = vi.fn().mockRejectedValue(failure);

    const result = await retryPolicy(FAST_RETRY).run(task);

    const error = result._unsafeUnwrapErr();
    expect(error.code).toBe('unavailable');
    expect(error.cause).toBe(failure);
  });

  it('passes a thrown DomainError through unchanged', async () => {
    const domainFailure = validationError('bad input');
    const task = vi.fn().mockRejectedValue(domainFailure);

    const result = await retryPolicy(FAST_RETRY).run(task);

    expect(result._unsafeUnwrapErr()).toBe(domainFailure);
  });

  it('schedules every backoff delay within [0, maxDelayMs] (jitter is bounded)', async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const task = vi.fn().mockRejectedValue(new Error('boom'));

    const pending = retryPolicy({ maxRetries: 3, initialDelayMs: 5, maxDelayMs: 20 }).run(task);
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(result.isErr()).toBe(true);
    const delays = setTimeoutSpy.mock.calls.map(([, delayMs]) => delayMs!);
    expect(delays).toHaveLength(3);
    for (const delayMs of delays) {
      expect(delayMs).toBeGreaterThanOrEqual(0);
      expect(delayMs).toBeLessThanOrEqual(20);
    }
    setTimeoutSpy.mockRestore();
  });
});

describe('timeoutPolicy', () => {
  it('resolves ok when the task finishes within the deadline', async () => {
    const result = await timeoutPolicy({ timeoutMs: 1000 }).run(() => Promise.resolve('quick'));

    expect(result._unsafeUnwrap()).toBe('quick');
  });

  it('yields a timeout error when the task hangs past the deadline', async () => {
    vi.useFakeTimers();
    const pending = timeoutPolicy({ timeoutMs: 50 }).run(() => new Promise<never>(() => {}));

    await vi.advanceTimersByTimeAsync(50);

    const result = await pending;
    expect(result._unsafeUnwrapErr().code).toBe('timeout');
  });

  it('aborts the task signal at the deadline for cooperative cancellation', async () => {
    vi.useFakeTimers();
    let observed: AbortSignal | undefined;
    const pending = timeoutPolicy({ timeoutMs: 50 }).run((signal) => {
      observed = signal;
      return new Promise<never>(() => {});
    });

    await vi.advanceTimersByTimeAsync(50);
    await pending;

    expect(observed?.aborted).toBe(true);
  });
});

describe('lazy cockatiel loading', () => {
  it('defers cockatiel module evaluation until the first run', async () => {
    vi.resetModules();
    let evaluated = false;
    vi.doMock('cockatiel', async () => {
      evaluated = true;
      return await vi.importActual('cockatiel');
    });

    const { retryPolicy: freshRetryPolicy } = await import('./policies.js');
    const runner = freshRetryPolicy(FAST_RETRY);
    expect(evaluated).toBe(false);

    const result = await runner.run(() => Promise.resolve('ok'));

    expect(result._unsafeUnwrap()).toBe('ok');
    expect(evaluated).toBe(true);
    vi.doUnmock('cockatiel');
    vi.resetModules();
  });

  it('maps a failed cockatiel load to an unavailable error', async () => {
    vi.resetModules();
    vi.doMock('cockatiel', () => {
      throw new Error('module load failed');
    });

    const { retryPolicy: freshRetryPolicy } = await import('./policies.js');
    const result = await freshRetryPolicy(FAST_RETRY).run(() => Promise.resolve('never'));

    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
    vi.doUnmock('cockatiel');
    vi.resetModules();
  });
});

describe('retryWithTimeoutPolicy', () => {
  it('times out a hung attempt and succeeds on a fast retry', async () => {
    const task = vi
      .fn<(signal: AbortSignal) => Promise<string>>()
      .mockImplementationOnce(() => new Promise<never>(() => {}))
      .mockResolvedValue('second try');

    const result = await retryWithTimeoutPolicy({ ...FAST_RETRY, timeoutMs: 30 }).run(task);

    expect(result._unsafeUnwrap()).toBe('second try');
    expect(task).toHaveBeenCalledTimes(2);
  });

  it('yields a timeout error after every attempt hangs', async () => {
    const task = vi.fn(() => new Promise<never>(() => {}));

    const result = await retryWithTimeoutPolicy({ ...FAST_RETRY, timeoutMs: 10 }).run(task);

    expect(result._unsafeUnwrapErr().code).toBe('timeout');
    expect(task).toHaveBeenCalledTimes(3);
  });
});
