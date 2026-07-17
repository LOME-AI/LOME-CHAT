import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { QueryCacheNotifyEvent } from '@tanstack/react-query';
import { blobCacheKeys } from '@/lib/query-keys/blob-cache-keys';
import { installBlobUrlCacheGc } from './blob-url-cache-gc';

// A minimal QueryClient stand-in: getQueryCache().subscribe captures the
// listener so tests can drive synthetic cache events through it.
function makeClient(): {
  client: Parameters<typeof installBlobUrlCacheGc>[0];
  emit: (event: unknown) => void;
  unsubscribe: ReturnType<typeof vi.fn>;
} {
  let listener: ((event: unknown) => void) | undefined;
  const unsubscribe = vi.fn();
  const client = {
    getQueryCache: () => ({
      subscribe: (listenerFunction: (event: unknown) => void) => {
        listener = listenerFunction;
        return unsubscribe;
      },
    }),
  } as unknown as Parameters<typeof installBlobUrlCacheGc>[0];
  return {
    client,
    emit: (event) => listener?.(event),
    unsubscribe,
  };
}

function removedEvent(queryKey: readonly unknown[], data: unknown): QueryCacheNotifyEvent {
  return {
    type: 'removed',
    query: { queryKey, state: { data } },
  } as unknown as QueryCacheNotifyEvent;
}

describe('installBlobUrlCacheGc', () => {
  let revokeSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    revokeSpy = vi.fn();
    vi.stubGlobal('URL', { ...globalThis.URL, revokeObjectURL: revokeSpy });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the cache unsubscribe function', () => {
    const { client, unsubscribe } = makeClient();
    const off = installBlobUrlCacheGc(client);
    expect(off).toBe(unsubscribe);
  });

  it('revokes the object URL when a blob-cache entry is evicted with a string URL', () => {
    const { client, emit } = makeClient();
    installBlobUrlCacheGc(client);

    emit(removedEvent(blobCacheKeys.blob('item-1'), 'blob:http://x/abc'));

    expect(revokeSpy).toHaveBeenCalledWith('blob:http://x/abc');
  });

  it('ignores non-removal cache events', () => {
    const { client, emit } = makeClient();
    installBlobUrlCacheGc(client);

    emit({
      type: 'added',
      query: { queryKey: blobCacheKeys.blob('item-1'), state: { data: 'blob:x' } },
    });

    expect(revokeSpy).not.toHaveBeenCalled();
  });

  it('ignores evictions of unrelated (non-blob) queries', () => {
    const { client, emit } = makeClient();
    installBlobUrlCacheGc(client);

    emit(removedEvent(['media', 'fetch', 'item-1', 'http://x'], 'blob:x'));
    emit(removedEvent(['conversations', 'list'], 'blob:x'));

    expect(revokeSpy).not.toHaveBeenCalled();
  });

  it('does not revoke when the evicted blob entry has non-string data', () => {
    const { client, emit } = makeClient();
    installBlobUrlCacheGc(client);

    // Non-string data (a number) exercises the `typeof data === 'string'` guard.
    emit(removedEvent(blobCacheKeys.blob('item-1'), 42));

    expect(revokeSpy).not.toHaveBeenCalled();
  });
});
