import type { Context } from 'hono';
import type { AppEnv } from '../types.js';

/** Safely access `c.executionCtx` — returns `undefined` outside Workers runtime. */
export function safeExecutionCtx(
  c: Context<AppEnv>
): { waitUntil(p: Promise<unknown>): void } | undefined {
  try {
    return c.executionCtx;
  } catch {
    return undefined;
  }
}
