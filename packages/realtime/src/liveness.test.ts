import { describe, expect, it } from 'vitest';
import { createCachedLiveness } from './liveness.js';
import type { LivenessOutcome, LivenessProbe } from './liveness.js';

interface HarnessConfig {
  cacheOutcome?: LivenessOutcome | null;
  cacheFails?: boolean;
  sourceOutcome?: LivenessOutcome;
  sourceFails?: boolean;
  writeFails?: boolean;
}

function harness(initial: HarnessConfig = {}): {
  decide(key?: string): Promise<string>;
  reconfigure(config: HarnessConfig): void;
  setNow(value: number): void;
  readonly cacheReads: number;
  readonly sourceReads: number;
  readonly writes: LivenessOutcome[];
} {
  let config = initial;
  let now = 1000;
  const counters = { cacheReads: 0, sourceReads: 0 };
  const writes: LivenessOutcome[] = [];
  const cached = createCachedLiveness({
    freshnessMs: 5000,
    lastKnownGoodMs: 60_000,
    now: () => now,
  });
  const probe: LivenessProbe = {
    readCache: () => {
      counters.cacheReads += 1;
      if (config.cacheFails === true) return Promise.reject(new Error('cache down'));
      return Promise.resolve(config.cacheOutcome ?? null);
    },
    readSource: () => {
      counters.sourceReads += 1;
      if (config.sourceFails === true) return Promise.reject(new Error('source down'));
      return Promise.resolve(config.sourceOutcome ?? 'live');
    },
    writeCache: (outcome) => {
      if (config.writeFails === true) return Promise.reject(new Error('write down'));
      writes.push(outcome);
      return Promise.resolve();
    },
  };
  return {
    decide: (key = 'k1') => cached.decide(key, probe),
    reconfigure: (next) => {
      config = next;
    },
    setNow: (value) => {
      now = value;
    },
    get cacheReads() {
      return counters.cacheReads;
    },
    get sourceReads() {
      return counters.sourceReads;
    },
    writes,
  };
}

describe('cache hits', () => {
  it('answers live from the cache without a source read', async () => {
    const h = harness({ cacheOutcome: 'live' });
    await expect(h.decide()).resolves.toBe('live');
    expect(h.sourceReads).toBe(0);
  });

  it('answers dead from the cache', async () => {
    await expect(harness({ cacheOutcome: 'dead' }).decide()).resolves.toBe('dead');
  });
});

describe('cache misses', () => {
  it('rechecks the source and writes the recheck back', async () => {
    const h = harness({ cacheOutcome: null, sourceOutcome: 'live' });
    await expect(h.decide()).resolves.toBe('live');
    expect(h.sourceReads).toBe(1);
    expect(h.writes).toEqual(['live']);
  });

  it('still answers when the write-back fails', async () => {
    const h = harness({ cacheOutcome: null, sourceOutcome: 'live', writeFails: true });
    await expect(h.decide()).resolves.toBe('live');
  });

  it('pauses when the source read fails with no prior decision', async () => {
    await expect(harness({ cacheOutcome: null, sourceFails: true }).decide()).resolves.toBe(
      'pause'
    );
  });
});

describe('memoization', () => {
  it('reuses a fresh decision without re-reading the cache', async () => {
    const h = harness({ cacheOutcome: 'live' });
    await h.decide();
    h.setNow(2000);
    await h.decide();
    expect(h.cacheReads).toBe(1);
  });

  it('re-reads the cache once the decision goes stale', async () => {
    const h = harness({ cacheOutcome: 'live' });
    await h.decide();
    h.setNow(7000);
    await h.decide();
    expect(h.cacheReads).toBe(2);
  });

  it('keeps keys isolated', async () => {
    const h = harness({ cacheOutcome: 'live' });
    await h.decide('a');
    await h.decide('b');
    expect(h.cacheReads).toBe(2);
  });
});

describe('fail-closed last-known-good window', () => {
  it('keeps a recently verified live target when the cache is down', async () => {
    const h = harness({ cacheOutcome: 'live' });
    await h.decide();
    h.reconfigure({ cacheFails: true });
    h.setNow(10_000);
    await expect(h.decide()).resolves.toBe('live');
  });

  it('pauses a live target verified beyond the window when the cache is down', async () => {
    const h = harness({ cacheOutcome: 'live' });
    await h.decide();
    h.reconfigure({ cacheFails: true });
    h.setNow(70_000);
    await expect(h.decide()).resolves.toBe('pause');
  });

  it('pauses when the cache is down and the key was never verified', async () => {
    await expect(harness({ cacheFails: true }).decide()).resolves.toBe('pause');
  });

  it('never un-dead-s on failure regardless of the window', async () => {
    const h = harness({ cacheOutcome: 'dead' });
    await h.decide();
    h.reconfigure({ cacheFails: true });
    h.setNow(70_000);
    await expect(h.decide()).resolves.toBe('dead');
  });

  it('applies the window when the source fails on a miss', async () => {
    const h = harness({ cacheOutcome: 'live' });
    await h.decide();
    h.reconfigure({ cacheOutcome: null, sourceFails: true });
    h.setNow(10_000);
    await expect(h.decide()).resolves.toBe('live');
  });
});
