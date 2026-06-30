import { describe, it, expect } from 'vitest';
import { safeExecutionCtx } from './safe-execution-ctx.js';
import type { Context } from 'hono';
import type { AppEnv } from '../types.js';

describe('safeExecutionCtx', () => {
  it('returns executionCtx when available', () => {
    const waitUntil = (): void => {};
    const fakeCtx = {
      get executionCtx() {
        return { waitUntil };
      },
    } as unknown as Context<AppEnv>;

    const result = safeExecutionCtx(fakeCtx);

    expect(result).toEqual({ waitUntil });
  });

  it('returns undefined when executionCtx throws', () => {
    const fakeCtx = {
      get executionCtx(): never {
        throw new Error('Not available');
      },
    } as unknown as Context<AppEnv>;

    const result = safeExecutionCtx(fakeCtx);

    expect(result).toBeUndefined();
  });

  it('returns falsy value when executionCtx is not available', () => {
    const notAvailable = undefined as { waitUntil(p: Promise<unknown>): void } | undefined;
    const fakeCtx = {
      get executionCtx() {
        return notAvailable;
      },
    } as unknown as Context<AppEnv>;

    const result = safeExecutionCtx(fakeCtx);

    expect(result).toBeUndefined();
  });
});
