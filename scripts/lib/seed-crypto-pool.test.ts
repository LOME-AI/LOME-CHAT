import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import path from 'node:path';
import {
  cacheKey,
  CACHE_VERSION,
  encodePersonaCrypto,
  readCache,
  writeCache,
  type CachedPersonaCrypto,
} from './seed-crypto-cache.js';
import {
  chunkRequests,
  ensurePersonaCrypto,
  type ChunkRunner,
  type PersonaCryptoRequest,
} from './seed-crypto-pool.js';

const FINGERPRINT = 'f'.repeat(64);
const MASTER_SECRET = 'dev-master-secret';

function bytes(n: number, fill: number): Uint8Array {
  return new Uint8Array(n).fill(fill);
}

function fakeCrypto(credId: string) {
  return {
    credentialIdentifier: credId,
    opaqueRegistration: bytes(192, hashByte(credId, 0)),
    publicKey: bytes(32, hashByte(credId, 1)),
    passwordWrappedPrivateKey: bytes(48, hashByte(credId, 2)),
    recoveryWrappedPrivateKey: bytes(48, hashByte(credId, 3)),
  };
}

function hashByte(input: string, salt: number): number {
  let h = salt;
  for (let index = 0; index < input.length; index++) {
    h = (h * 31 + (input.codePointAt(index) ?? 0)) & 0xff;
  }
  return h;
}

function makeRunner(): { runner: ChunkRunner; calls: PersonaCryptoRequest[][] } {
  const calls: PersonaCryptoRequest[][] = [];
  const runner: ChunkRunner = (chunk) => {
    calls.push(chunk);
    return Promise.resolve(chunk.map((req) => fakeCrypto(req.credentialIdentifier)));
  };
  return { runner, calls };
}

function keyFor(credId: string, password = 'pw'): string {
  return cacheKey({
    cacheVersion: CACHE_VERSION,
    cryptoFingerprint: FINGERPRINT,
    masterSecret: MASTER_SECRET,
    password,
    credentialIdentifier: credId,
  });
}

function entryFor(credId: string, password = 'pw'): [string, CachedPersonaCrypto] {
  const key = keyFor(credId, password);
  return [key, encodePersonaCrypto(fakeCrypto(credId), key, credId)];
}

let temporaryDir: string;
let cacheFile: string;
beforeEach(async () => {
  temporaryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'seed-crypto-pool-test-'));
  cacheFile = path.join(temporaryDir, 'seed-crypto.json');
});
afterEach(async () => {
  await fs.rm(temporaryDir, { recursive: true, force: true });
});

describe('chunkRequests', () => {
  it('returns one chunk per worker when requests >= workers', () => {
    const requests = Array.from({ length: 10 }, (_, index) => ({
      credentialIdentifier: `id-${String(index)}`,
      password: 'pw',
    }));
    const chunks = chunkRequests(requests, 3);
    expect(chunks).toHaveLength(3);
    expect(chunks.flat()).toHaveLength(10);
  });

  it('distributes round-robin (balanced sizes)', () => {
    const requests = Array.from({ length: 10 }, (_, index) => ({
      credentialIdentifier: `id-${String(index)}`,
      password: 'pw',
    }));
    const chunks = chunkRequests(requests, 3);
    expect(chunks[0]).toHaveLength(4);
    expect(chunks[1]).toHaveLength(3);
    expect(chunks[2]).toHaveLength(3);
  });

  it('drops empty chunks when requests < workers', () => {
    const requests = [{ credentialIdentifier: 'id-0', password: 'pw' }];
    const chunks = chunkRequests(requests, 4);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(1);
  });

  it('handles empty input', () => {
    expect(chunkRequests([], 4)).toEqual([]);
  });
});

describe('ensurePersonaCrypto', () => {
  const baseOptions = (
    overrides: Partial<Parameters<typeof ensurePersonaCrypto>[1]> = {}
  ): Parameters<typeof ensurePersonaCrypto>[1] => ({
    cacheFile,
    cacheVersion: CACHE_VERSION,
    cryptoFingerprint: FINGERPRINT,
    masterSecret: MASTER_SECRET,
    workerCount: 2,
    ...overrides,
  });

  async function seedCacheFile(
    entries: [string, CachedPersonaCrypto][],
    meta?: { cacheVersion: string; cryptoFingerprint: string }
  ): Promise<void> {
    const resolved = meta ?? { cacheVersion: CACHE_VERSION, cryptoFingerprint: FINGERPRINT };
    await writeCache(cacheFile, { ...resolved, entries: new Map(entries) });
  }

  it('returns empty map for empty requests, no runChunk calls', async () => {
    const { runner, calls } = makeRunner();
    const result = await ensurePersonaCrypto([], baseOptions({ runChunk: runner }));
    expect(result.size).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('reads from cache when entry exists (no runChunk calls)', async () => {
    const credId = 'cred-1';
    await seedCacheFile([entryFor(credId)]);

    const { runner, calls } = makeRunner();
    const result = await ensurePersonaCrypto(
      [{ credentialIdentifier: credId, password: 'pw' }],
      baseOptions({ runChunk: runner })
    );

    expect(calls).toHaveLength(0);
    expect(result.get(credId)?.opaqueRegistration).toEqual(fakeCrypto(credId).opaqueRegistration);
  });

  it('defaults workerCount to the cpu count when omitted', async () => {
    const { runner, calls } = makeRunner();
    const requests = [{ credentialIdentifier: 'cred-w', password: 'pw' }];
    // Omit workerCount entirely so the `?? Math.max(...)` default is exercised.
    const result = await ensurePersonaCrypto(requests, {
      cacheFile,
      cacheVersion: CACHE_VERSION,
      cryptoFingerprint: FINGERPRINT,
      masterSecret: MASTER_SECRET,
      runChunk: runner,
    });
    expect(calls.flat()).toHaveLength(1);
    expect(result.get('cred-w')?.publicKey).toEqual(fakeCrypto('cred-w').publicKey);
  });

  it('dispatches misses to runChunk and persists results to the whole-file cache', async () => {
    const { runner, calls } = makeRunner();
    const requests = [
      { credentialIdentifier: 'cred-a', password: 'pw' },
      { credentialIdentifier: 'cred-b', password: 'pw' },
    ];
    const result = await ensurePersonaCrypto(requests, baseOptions({ runChunk: runner }));

    expect(calls.flat()).toHaveLength(2);
    expect(result.get('cred-a')?.publicKey).toEqual(fakeCrypto('cred-a').publicKey);
    expect(result.get('cred-b')?.publicKey).toEqual(fakeCrypto('cred-b').publicKey);

    const persisted = await readCache(cacheFile);
    expect(persisted.cacheVersion).toBe(CACHE_VERSION);
    expect(persisted.cryptoFingerprint).toBe(FINGERPRINT);
    expect(persisted.entries.get(keyFor('cred-a'))?.credentialIdentifier).toBe('cred-a');
    expect(persisted.entries.get(keyFor('cred-b'))?.credentialIdentifier).toBe('cred-b');
  });

  it('handles mixed hits and misses', async () => {
    const hitCredId = 'hit-1';
    await seedCacheFile([entryFor(hitCredId)]);

    const { runner, calls } = makeRunner();
    const result = await ensurePersonaCrypto(
      [
        { credentialIdentifier: hitCredId, password: 'pw' },
        { credentialIdentifier: 'miss-1', password: 'pw' },
      ],
      baseOptions({ runChunk: runner })
    );

    expect(calls.flat().map((r) => r.credentialIdentifier)).toEqual(['miss-1']);
    expect(result.size).toBe(2);
  });

  it('splits misses across workerCount chunks via runChunk', async () => {
    const requests = Array.from({ length: 6 }, (_, index) => ({
      credentialIdentifier: `cred-${String(index)}`,
      password: 'pw',
    }));
    const { runner, calls } = makeRunner();
    await ensurePersonaCrypto(requests, baseOptions({ runChunk: runner, workerCount: 3 }));
    expect(calls).toHaveLength(3);
    expect(calls.flat()).toHaveLength(6);
  });

  it('propagates runChunk errors', async () => {
    const failingRunner: ChunkRunner = vi.fn(() => Promise.reject(new Error('worker boom')));
    await expect(
      ensurePersonaCrypto(
        [{ credentialIdentifier: 'cred', password: 'pw' }],
        baseOptions({ runChunk: failingRunner })
      )
    ).rejects.toThrow('worker boom');
  });

  it('does not call runChunk when every request is satisfied from cache', async () => {
    const credIds = ['a', 'b', 'c'];
    await seedCacheFile(credIds.map((id) => entryFor(id)));

    const { runner, calls } = makeRunner();
    const result = await ensurePersonaCrypto(
      credIds.map((id) => ({ credentialIdentifier: id, password: 'pw' })),
      baseOptions({ runChunk: runner })
    );
    expect(calls).toHaveLength(0);
    expect(result.size).toBe(3);
  });

  it('performs no write on a pure-hit run (file bytes unchanged)', async () => {
    await seedCacheFile([entryFor('cred-hit')]);
    const before = await fs.readFile(cacheFile, 'utf8');

    const { runner } = makeRunner();
    await ensurePersonaCrypto(
      [{ credentialIdentifier: 'cred-hit', password: 'pw' }],
      baseOptions({ runChunk: runner })
    );

    const after = await fs.readFile(cacheFile, 'utf8');
    expect(after).toBe(before);
  });

  it('wholesale-invalidates when the stored cryptoFingerprint differs (all miss, metadata rewritten current)', async () => {
    // Seed a valid entry under a STALE fingerprint. cacheKey embeds the
    // fingerprint, so this entry's key belongs to the old world.
    const staleFingerprint = 'e'.repeat(64);
    const staleKey = cacheKey({
      cacheVersion: CACHE_VERSION,
      cryptoFingerprint: staleFingerprint,
      masterSecret: MASTER_SECRET,
      password: 'pw',
      credentialIdentifier: 'cred-a',
    });
    await seedCacheFile(
      [[staleKey, encodePersonaCrypto(fakeCrypto('cred-a'), staleKey, 'cred-a')]],
      {
        cacheVersion: CACHE_VERSION,
        cryptoFingerprint: staleFingerprint,
      }
    );

    const { runner, calls } = makeRunner();
    await ensurePersonaCrypto(
      [{ credentialIdentifier: 'cred-a', password: 'pw' }],
      baseOptions({ runChunk: runner })
    );

    // Every request missed despite a same-cred entry existing under the old key.
    expect(calls.flat().map((r) => r.credentialIdentifier)).toEqual(['cred-a']);

    const persisted = await readCache(cacheFile);
    expect(persisted.cryptoFingerprint).toBe(FINGERPRINT);
    expect(persisted.cacheVersion).toBe(CACHE_VERSION);
    // The stale entry is gone; only the freshly keyed entry remains.
    expect(persisted.entries.has(staleKey)).toBe(false);
    expect(persisted.entries.has(keyFor('cred-a'))).toBe(true);
    expect(persisted.entries.size).toBe(1);
  });

  it('wholesale-invalidates when the stored cacheVersion differs', async () => {
    const staleKey = cacheKey({
      cacheVersion: '999',
      cryptoFingerprint: FINGERPRINT,
      masterSecret: MASTER_SECRET,
      password: 'pw',
      credentialIdentifier: 'cred-a',
    });
    await seedCacheFile(
      [[staleKey, encodePersonaCrypto(fakeCrypto('cred-a'), staleKey, 'cred-a')]],
      {
        cacheVersion: '999',
        cryptoFingerprint: FINGERPRINT,
      }
    );

    const { runner, calls } = makeRunner();
    await ensurePersonaCrypto(
      [{ credentialIdentifier: 'cred-a', password: 'pw' }],
      baseOptions({ runChunk: runner })
    );

    expect(calls.flat()).toHaveLength(1);
    const persisted = await readCache(cacheFile);
    expect(persisted.cacheVersion).toBe(CACHE_VERSION);
    expect(persisted.entries.has(staleKey)).toBe(false);
  });

  it('accumulates across two sequential calls with matching metadata (no clobber)', async () => {
    const { runner: runner1 } = makeRunner();
    await ensurePersonaCrypto(
      [{ credentialIdentifier: 'cred-a', password: 'pw' }],
      baseOptions({ runChunk: runner1 })
    );

    // Second call requests a DIFFERENT persona against the same file/metadata.
    const { runner: runner2, calls: calls2 } = makeRunner();
    await ensurePersonaCrypto(
      [{ credentialIdentifier: 'cred-b', password: 'pw' }],
      baseOptions({ runChunk: runner2 })
    );

    // Only cred-b was recomputed on the second call.
    expect(calls2.flat().map((r) => r.credentialIdentifier)).toEqual(['cred-b']);

    // The rewritten file still carries the first call's entry — not clobbered.
    const persisted = await readCache(cacheFile);
    expect(persisted.entries.has(keyFor('cred-a'))).toBe(true);
    expect(persisted.entries.has(keyFor('cred-b'))).toBe(true);
    expect(persisted.entries.size).toBe(2);
  });

  it('merges: rewritten file preserves pre-existing valid entries not part of this call', async () => {
    // A valid, current-metadata entry for a persona this call never requests.
    await seedCacheFile([entryFor('bystander')]);

    const { runner } = makeRunner();
    await ensurePersonaCrypto(
      [{ credentialIdentifier: 'newcomer', password: 'pw' }],
      baseOptions({ runChunk: runner })
    );

    const persisted = await readCache(cacheFile);
    expect(persisted.entries.has(keyFor('bystander'))).toBe(true);
    expect(persisted.entries.has(keyFor('newcomer'))).toBe(true);
    expect(persisted.entries.size).toBe(2);
  });
});
