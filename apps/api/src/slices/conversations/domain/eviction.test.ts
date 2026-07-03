import { describe, expect, it } from 'vitest';
import { unavailableError } from '../../../lib/errors/index.js';
import { errAsync, okAsync } from '../../../lib/result/index.js';
import { evictPrincipals } from './eviction.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { MembershipRevoker, RealtimeBroadcast } from '../ports/index.js';

function recordingRevoker(calls: string[], failFor: string | null = null): MembershipRevoker {
  return {
    invalidate: (_conversationId, principalId) => {
      calls.push(principalId);
      return failFor === principalId ? errAsync(unavailableError('revoker down')) : okAsync();
    },
  };
}

function recordingRealtime(calls: string[], failFor: string | null = null): RealtimeBroadcast {
  return {
    broadcast: () => okAsync({ delivered: 0, paused: 0, evicted: 0 }),
    evict: (_conversationId, principalId) => {
      calls.push(principalId);
      return failFor === principalId
        ? errAsync<number, DomainError>(unavailableError('realtime down'))
        : okAsync(1);
    },
    presence: () => okAsync([]),
    startRun: () => okAsync({ started: true, runId: 'r', deadlineAt: 0 }),
    stopRun: () => okAsync(false),
  };
}

describe('evictPrincipals', () => {
  it('invalidates the cache and closes sockets for every principal', async () => {
    const revoked: string[] = [];
    const closed: string[] = [];
    const result = await evictPrincipals(
      { revoker: recordingRevoker(revoked), realtime: recordingRealtime(closed) },
      'c1',
      ['p1', 'p2']
    );
    expect(result.isOk()).toBe(true);
    expect(revoked).toEqual(['p1', 'p2']);
    expect(closed).toEqual(['p1', 'p2']);
  });

  it('keeps evicting the rest after a cache-invalidation failure and surfaces it', async () => {
    const revoked: string[] = [];
    const closed: string[] = [];
    const result = await evictPrincipals(
      { revoker: recordingRevoker(revoked, 'p1'), realtime: recordingRealtime(closed) },
      'c1',
      ['p1', 'p2']
    );
    expect(result._unsafeUnwrapErr().message).toContain('revoker down');
    expect(revoked).toEqual(['p1', 'p2']);
    expect(closed).toEqual(['p1', 'p2']);
  });

  it('surfaces a socket-eviction failure without skipping later principals', async () => {
    const closed: string[] = [];
    const result = await evictPrincipals(
      { revoker: recordingRevoker([]), realtime: recordingRealtime(closed, 'p1') },
      'c1',
      ['p1', 'p2']
    );
    expect(result._unsafeUnwrapErr().message).toContain('realtime down');
    expect(closed).toEqual(['p1', 'p2']);
  });

  it('keeps the first failure when both mechanisms fail', async () => {
    const result = await evictPrincipals(
      { revoker: recordingRevoker([], 'p1'), realtime: recordingRealtime([], 'p1') },
      'c1',
      ['p1']
    );
    expect(result._unsafeUnwrapErr().message).toContain('revoker down');
  });
});
