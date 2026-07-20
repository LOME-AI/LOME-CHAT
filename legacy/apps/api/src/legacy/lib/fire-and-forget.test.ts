import { describe, it, expect, vi } from 'vitest';
import { fireAndForget } from './fire-and-forget.js';

describe('fireAndForget', () => {
  it('does not throw when promise resolves', () => {
    const promise = Promise.resolve('success');
    expect(() => {
      fireAndForget(promise, 'test operation');
    }).not.toThrow();
  });

  it('logs rejected promises with error context', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = new Error('Test error');
    const promise = Promise.reject(error);

    fireAndForget(promise, 'test operation');

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(spy).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledWith('[fire-and-forget] test operation:', error);
    spy.mockRestore();
  });

  it('logs non-Error rejection values', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- testing non-Error rejection handling
    const promise = Promise.reject('string error');

    fireAndForget(promise, 'update balance');

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(spy).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledWith('[fire-and-forget] update balance:', 'string error');
    spy.mockRestore();
  });

  it('does not log when promise resolves', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const promise = Promise.resolve('success');

    fireAndForget(promise, 'test operation');

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('returns void (no return value)', () => {
    const promise = Promise.resolve('value');
    // eslint-disable-next-line @typescript-eslint/no-confusing-void-expression -- testing return type
    const result = fireAndForget(promise, 'test');
    expect(result).toBeUndefined();
  });

  it('calls waitUntil when executionCtx provided', () => {
    const waitUntil = vi.fn();
    const promise = Promise.resolve('value');

    fireAndForget(promise, 'test', { waitUntil });

    expect(waitUntil).toHaveBeenCalledOnce();
  });

  it('does not call waitUntil when executionCtx omitted', () => {
    const promise = Promise.resolve('value');

    expect(() => {
      fireAndForget(promise, 'test');
    }).not.toThrow();
  });

  it('handles executionCtx.waitUntil throwing gracefully', () => {
    const waitUntil = vi.fn().mockImplementation(() => {
      throw new Error('waitUntil unavailable');
    });
    const promise = Promise.resolve('value');

    expect(() => {
      fireAndForget(promise, 'test', { waitUntil });
    }).not.toThrow();
  });
});
