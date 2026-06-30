import { describe, expect, it } from 'vitest';
import { createCachedMembershipVerifier } from './revocation.js';
import type { MembershipCache, MembershipSource, MembershipState } from './revocation.js';

interface HarnessConfig {
  cacheState?: MembershipState | null;
  cacheFails?: boolean;
  sourceMember?: boolean;
  sourceFails?: boolean;
  setFails?: boolean;
}

interface Harness {
  verify(conversationId?: string, principalId?: string): Promise<string>;
  reconfigure(config: HarnessConfig): void;
  setNow(value: number): void;
  readonly cacheGets: number;
  readonly sourceCalls: number;
  readonly sets: { state: MembershipState; ttlSeconds: number }[];
}

function harness(initial: HarnessConfig = {}): Harness {
  let config = initial;
  let now = 1000;
  const counters = { cacheGets: 0, sourceCalls: 0 };
  const sets: { state: MembershipState; ttlSeconds: number }[] = [];
  const cache: MembershipCache = {
    get: () => {
      counters.cacheGets += 1;
      if (config.cacheFails === true) return Promise.reject(new Error('redis down'));
      return Promise.resolve(config.cacheState ?? null);
    },
    set: (_conversationId, _principalId, state, ttlSeconds) => {
      if (config.setFails === true) return Promise.reject(new Error('redis down'));
      sets.push({ state, ttlSeconds });
      return Promise.resolve();
    },
  };
  const source: MembershipSource = {
    isMember: () => {
      counters.sourceCalls += 1;
      if (config.sourceFails === true) return Promise.reject(new Error('db down'));
      return Promise.resolve(config.sourceMember ?? true);
    },
  };
  const verifier = createCachedMembershipVerifier({
    cache,
    source,
    freshnessMs: 5000,
    lastKnownGoodMs: 60_000,
    cacheTtlSeconds: 30,
    now: () => now,
  });
  return {
    verify: (conversationId = 'c1', principalId = 'u1') =>
      verifier.verify(conversationId, principalId),
    reconfigure: (next: HarnessConfig) => {
      config = next;
    },
    setNow: (value: number) => {
      now = value;
    },
    get cacheGets() {
      return counters.cacheGets;
    },
    get sourceCalls() {
      return counters.sourceCalls;
    },
    sets,
  };
}

describe('cache hits', () => {
  it('answers member from the cache without a source read', async () => {
    const h = harness({ cacheState: 'member' });
    await expect(h.verify()).resolves.toBe('member');
    expect(h.sourceCalls).toBe(0);
  });

  it('answers revoked from the cache', async () => {
    const h = harness({ cacheState: 'revoked' });
    await expect(h.verify()).resolves.toBe('revoked');
  });
});

describe('cache misses', () => {
  it('rechecks the source and answers member', async () => {
    const h = harness({ cacheState: null, sourceMember: true });
    await expect(h.verify()).resolves.toBe('member');
    expect(h.sourceCalls).toBe(1);
  });

  it('rechecks the source and answers revoked for a non-member', async () => {
    const h = harness({ cacheState: null, sourceMember: false });
    await expect(h.verify()).resolves.toBe('revoked');
  });

  it('writes the recheck result back with the configured ttl', async () => {
    const h = harness({ cacheState: null, sourceMember: true });
    await h.verify();
    expect(h.sets).toEqual([{ state: 'member', ttlSeconds: 30 }]);
  });

  it('still answers when the cache write-back fails', async () => {
    const h = harness({ cacheState: null, sourceMember: true, setFails: true });
    await expect(h.verify()).resolves.toBe('member');
  });

  it('pauses when the source read fails with no prior decision', async () => {
    const h = harness({ cacheState: null, sourceFails: true });
    await expect(h.verify()).resolves.toBe('pause');
  });
});

describe('memoization', () => {
  it('reuses a fresh decision without re-reading the cache', async () => {
    const h = harness({ cacheState: 'member' });
    await h.verify();
    h.setNow(2000);
    await h.verify();
    expect(h.cacheGets).toBe(1);
  });

  it('re-reads the cache once the decision goes stale', async () => {
    const h = harness({ cacheState: 'member' });
    await h.verify();
    h.setNow(7000);
    await h.verify();
    expect(h.cacheGets).toBe(2);
  });

  it('re-checks a stale revoked decision so a re-added member recovers', async () => {
    const h = harness({ cacheState: 'revoked' });
    await expect(h.verify()).resolves.toBe('revoked');
    h.setNow(7000);
    h.reconfigure({ cacheState: 'member' });
    await expect(h.verify()).resolves.toBe('member');
  });

  it('keeps principals isolated', async () => {
    const h = harness({ cacheState: 'member' });
    await h.verify('c1', 'u1');
    await h.verify('c1', 'u2');
    expect(h.cacheGets).toBe(2);
  });

  it('keeps conversations isolated', async () => {
    const h = harness({ cacheState: 'member' });
    await h.verify('c1', 'u1');
    await h.verify('c2', 'u1');
    expect(h.cacheGets).toBe(2);
  });
});

describe('infrastructure failure (bounded last-known-good window)', () => {
  it('keeps delivering to a recently verified member when the cache is down', async () => {
    const h = harness({ cacheState: 'member' });
    await h.verify();
    h.reconfigure({ cacheFails: true });
    h.setNow(10_000);
    await expect(h.verify()).resolves.toBe('member');
  });

  it('pauses a member verified beyond the window when the cache is down', async () => {
    const h = harness({ cacheState: 'member' });
    await h.verify();
    h.reconfigure({ cacheFails: true });
    h.setNow(70_000);
    await expect(h.verify()).resolves.toBe('pause');
  });

  it('pauses when the cache is down and the principal was never verified', async () => {
    const h = harness({ cacheFails: true });
    await expect(h.verify()).resolves.toBe('pause');
  });

  it('never un-revokes on failure regardless of the window', async () => {
    const h = harness({ cacheState: 'revoked' });
    await h.verify();
    h.reconfigure({ cacheFails: true });
    h.setNow(70_000);
    await expect(h.verify()).resolves.toBe('revoked');
  });

  it('applies the window when the source fails on a miss', async () => {
    const h = harness({ cacheState: 'member' });
    await h.verify();
    h.reconfigure({ cacheState: null, sourceFails: true });
    h.setNow(10_000);
    await expect(h.verify()).resolves.toBe('member');
  });
});
