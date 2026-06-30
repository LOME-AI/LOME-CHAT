import { describe, expect, it } from 'vitest';
import { unavailableError } from '../errors/index.js';
import { fromPromise } from './from-promise.js';

describe('fromPromise', () => {
  it('wraps a resolving promise in ok', async () => {
    const result = await fromPromise(Promise.resolve(42), () => unavailableError('unused'));

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBe(42);
  });

  it('maps a rejection into the supplied domain error', async () => {
    const result = await fromPromise(Promise.reject(new Error('boom')), (cause) =>
      unavailableError('upstream failed', cause)
    );

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('passes the rejection value to the mapper as the cause', async () => {
    const rejection = new Error('boom');

    const result = await fromPromise(Promise.reject(rejection), (cause) =>
      unavailableError('upstream failed', cause)
    );

    expect(result._unsafeUnwrapErr().cause).toBe(rejection);
  });
});
