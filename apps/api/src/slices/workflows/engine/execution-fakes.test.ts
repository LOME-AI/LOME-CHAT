import { describe, expect, it } from 'vitest';
import { createValueStore } from './value-store.js';
import { failWith, hangThenFail, respondWith, streamThenHang } from './execution-fakes.js';
import type { NodeRunContext } from './execution-registry.js';

function contextWith(signal: AbortSignal): NodeRunContext {
  return {
    values: createValueStore(64),
    clock: { now: () => 0 },
    rng: { random: () => 0.5 },
    signal,
  };
}

describe('streamThenHang', () => {
  it('resolves the partial immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const behavior = streamThenHang('partial', 3n);
    const result = await behavior.run([], contextWith(controller.signal));
    expect(result._unsafeUnwrap()).toEqual({ value: 'partial', costNanoUsd: 3n });
  });
});

describe('hangThenFail', () => {
  it('fails immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const behavior = hangThenFail();
    const result = await behavior.run([], contextWith(controller.signal));
    expect(result.isErr()).toBe(true);
  });
});

describe('respondWith', () => {
  it('defaults the reported spend to zero', async () => {
    const result = await respondWith('value').run([], contextWith(new AbortController().signal));
    expect(result._unsafeUnwrap()).toEqual({ value: 'value', costNanoUsd: 0n });
  });
});

describe('failWith', () => {
  it('carries the reported spend on the error channel', async () => {
    const result = await failWith(9n).run([], contextWith(new AbortController().signal));
    expect(result._unsafeUnwrapErr()).toEqual({ costNanoUsd: 9n });
  });
});
