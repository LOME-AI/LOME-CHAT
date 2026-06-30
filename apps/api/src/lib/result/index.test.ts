import { describe, expect, it } from 'vitest';
import { err, errAsync, fromPromise, ok, okAsync, Result, ResultAsync } from './index.js';

describe('result convention surface', () => {
  it('re-exports working ok/err constructors', () => {
    expect(ok(1).isOk()).toBe(true);
    expect(err('nope').isErr()).toBe(true);
  });

  it('re-exports working okAsync/errAsync constructors', async () => {
    const okResult = await okAsync(1);
    const errResult = await errAsync('nope');
    expect(okResult.isOk()).toBe(true);
    expect(errResult.isErr()).toBe(true);
  });

  it('re-exports the Result combinators namespace', () => {
    const combined = Result.combine([ok(1), ok(2)]);
    expect(combined._unsafeUnwrap()).toEqual([1, 2]);
  });

  it('re-exports the ResultAsync class', () => {
    expect(okAsync(1)).toBeInstanceOf(ResultAsync);
  });

  it('exports the typed fromPromise wrapper', () => {
    expect(typeof fromPromise).toBe('function');
  });
});
