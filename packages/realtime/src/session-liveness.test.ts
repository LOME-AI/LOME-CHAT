import { describe, expect, it } from 'vitest';
import { createCachedSessionVerifier } from './session-liveness.js';
import type { SessionSnapshot, SessionSource, SessionState } from './session-liveness.js';

const SNAPSHOT: SessionSnapshot = { userId: 'u1', sessionId: 's1', sessionCreatedAt: 100 };

function harness(initial: { state?: SessionState; fails?: boolean } = {}): {
  verify(snapshot?: SessionSnapshot): Promise<string>;
  reconfigure(config: { state?: SessionState; fails?: boolean }): void;
  setNow(value: number): void;
  readonly sourceReads: number;
} {
  let config = initial;
  let now = 1000;
  let sourceReads = 0;
  const source: SessionSource = {
    liveness: () => {
      sourceReads += 1;
      if (config.fails === true) return Promise.reject(new Error('redis down'));
      return Promise.resolve(config.state ?? 'live');
    },
  };
  const verifier = createCachedSessionVerifier({
    source,
    freshnessMs: 2000,
    lastKnownGoodMs: 15_000,
    now: () => now,
  });
  return {
    verify: (snapshot = SNAPSHOT) => verifier.verify(snapshot),
    reconfigure: (next) => {
      config = next;
    },
    setNow: (value) => {
      now = value;
    },
    get sourceReads() {
      return sourceReads;
    },
  };
}

describe('createCachedSessionVerifier', () => {
  it('delivers to a live session', async () => {
    await expect(harness({ state: 'live' }).verify()).resolves.toBe('live');
  });

  it('revokes a session the source reports revoked', async () => {
    await expect(harness({ state: 'revoked' }).verify()).resolves.toBe('revoked');
  });

  it('reads the source at most once per freshness window (bounded, not per token)', async () => {
    const h = harness({ state: 'live' });
    await h.verify();
    h.setNow(1500);
    await h.verify();
    expect(h.sourceReads).toBe(1);
  });

  it('re-checks the source once the memo goes stale', async () => {
    const h = harness({ state: 'live' });
    await h.verify();
    h.setNow(4000);
    await h.verify();
    expect(h.sourceReads).toBe(2);
  });

  it('keeps distinct session snapshots isolated', async () => {
    const h = harness({ state: 'live' });
    await h.verify({ userId: 'u1', sessionId: 's1', sessionCreatedAt: 100 });
    await h.verify({ userId: 'u1', sessionId: 's1', sessionCreatedAt: 200 });
    expect(h.sourceReads).toBe(2);
  });

  it('pauses on a source failure with no prior decision (fail-closed)', async () => {
    await expect(harness({ fails: true }).verify()).resolves.toBe('pause');
  });

  it('keeps delivering to a recently live session within the last-known-good window', async () => {
    const h = harness({ state: 'live' });
    await h.verify();
    h.reconfigure({ fails: true });
    h.setNow(10_000);
    await expect(h.verify()).resolves.toBe('live');
  });

  it('pauses a session verified beyond the last-known-good window on failure', async () => {
    const h = harness({ state: 'live' });
    await h.verify();
    h.reconfigure({ fails: true });
    h.setNow(20_000);
    await expect(h.verify()).resolves.toBe('pause');
  });

  it('never un-revokes on a source failure', async () => {
    const h = harness({ state: 'revoked' });
    await h.verify();
    h.reconfigure({ fails: true });
    h.setNow(20_000);
    await expect(h.verify()).resolves.toBe('revoked');
  });
});
