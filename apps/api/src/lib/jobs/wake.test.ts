import { describe, expect, it } from 'vitest';
import { wakeJobDispatcher } from './wake.js';
import type { JobDispatcherNamespace } from './wake.js';

interface RecordedFetch {
  readonly name: string;
  readonly url: string;
  readonly method: string;
}

function fakeNamespace(
  calls: RecordedFetch[],
  behavior: 'ok' | 'reject' | 'throw-sync' = 'ok'
): JobDispatcherNamespace {
  return {
    idFromName: (name: string) => name,
    get: (id) => ({
      fetch: (url: string, init?: { method: string }) => {
        if (behavior === 'throw-sync') throw new Error('stub gone');
        calls.push({
          name: String(id),
          url,
          method: init === undefined ? 'GET' : init.method,
        });
        return behavior === 'reject'
          ? Promise.reject(new Error('network down'))
          : Promise.resolve();
      },
    }),
  };
}

describe('wakeJobDispatcher', () => {
  it('posts a wake to the shard-named dispatcher', async () => {
    const calls: RecordedFetch[] = [];
    await wakeJobDispatcher(fakeNamespace(calls), 'default');
    expect(calls).toEqual([
      { name: 'default', url: 'https://job-dispatcher/wake', method: 'POST' },
    ]);
  });

  it('addresses the bulk shard by name', async () => {
    const calls: RecordedFetch[] = [];
    await wakeJobDispatcher(fakeNamespace(calls), 'bulk');
    expect(calls[0]?.name).toBe('bulk');
  });

  it('swallows a rejected wake — the nudge is lossy by design', async () => {
    const calls: RecordedFetch[] = [];
    await expect(
      wakeJobDispatcher(fakeNamespace(calls, 'reject'), 'default')
    ).resolves.toBeUndefined();
  });

  it('swallows a synchronous stub failure', async () => {
    const calls: RecordedFetch[] = [];
    await expect(
      wakeJobDispatcher(fakeNamespace(calls, 'throw-sync'), 'default')
    ).resolves.toBeUndefined();
  });
});
