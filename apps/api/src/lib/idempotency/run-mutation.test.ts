import { describe, expect, it } from 'vitest';
import { unavailableError } from '../errors/index.js';
import { errAsync, okAsync } from '../result/index.js';
import { byUpsert } from './by-upsert.js';
import { idempotent } from './idempotent.js';
import { runMutation } from './run-mutation.js';
import type { DomainError } from '../errors/index.js';

describe('runMutation', () => {
  it('executes a wrapper-produced mutation and returns its value', async () => {
    const result = await runMutation(() => byUpsert(() => okAsync(7)));
    expect(result._unsafeUnwrap()).toBe(7);
  });

  it('propagates the mutation error channel', async () => {
    const result = await runMutation(() =>
      byUpsert(() => errAsync<number, DomainError>(unavailableError('down')))
    );
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('accepts only Idempotent-branded mutations', async () => {
    const rejected = runMutation(
      // @ts-expect-error — a bare ResultAsync lacks the Idempotent brand; only idempotent.* wrappers produce it
      () => okAsync(7)
    );
    const settled = await rejected;
    expect(settled.isOk()).toBe(true);
  });
});

describe('idempotent namespace', () => {
  it('exposes exactly the five wrappers', () => {
    expect(new Set(Object.keys(idempotent))).toEqual(
      new Set(['byKey', 'byUpsert', 'byTransition', 'byEventId', 'byExternalPreClaim'])
    );
  });
});
