import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import path from 'node:path';
import {
  cacheKey,
  cacheFilePath,
  CACHE_VERSION,
  encodePersonaCrypto,
  readCacheEntry,
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

let cacheDir: string;
beforeEach(async () => {
  cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'seed-crypto-pool-test-'));
});
afterEach(async () => {
  await fs.rm(cacheDir, { recursive: true, force: true });
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
    cacheDir,
    cacheVersion: CACHE_VERSION,
    cryptoFingerprint: FINGERPRINT,
    masterSecret: MASTER_SECRET,
    workerCount: 2,
    ...overrides,
  });

  it('returns empty map for empty requests, no runChunk calls', async () => {
    const { runner, calls } = makeRunner();
    const result = await ensurePersonaCrypto([], baseOptions({ runChunk: runner }));
    expect(result.size).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('reads from cache when entry exists (no runChunk calls)', async () => {
    const credId = 'cred-1';
    const password = 'pw';
    const key = cacheKey({
      cacheVersion: CACHE_VERSION,
      cryptoFingerprint: FINGERPRINT,
      masterSecret: MASTER_SECRET,
      password,
      credentialIdentifier: credId,
    });
    const crypto = fakeCrypto(credId);
    const entry = encodePersonaCrypto(crypto, key, credId);
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(cacheFilePath(cacheDir, key), JSON.stringify(entry));

    const { runner, calls } = makeRunner();
    const result = await ensurePersonaCrypto(
      [{ credentialIdentifier: credId, password }],
      baseOptions({ runChunk: runner })
    );

    expect(calls).toHaveLength(0);
    expect(result.get(credId)?.opaqueRegistration).toEqual(crypto.opaqueRegistration);
  });

  it('dispatches misses to runChunk and persists results', async () => {
    const { runner, calls } = makeRunner();
    const requests = [
      { credentialIdentifier: 'cred-a', password: 'pw' },
      { credentialIdentifier: 'cred-b', password: 'pw' },
    ];
    const result = await ensurePersonaCrypto(requests, baseOptions({ runChunk: runner }));

    expect(calls.flat()).toHaveLength(2);
    expect(result.get('cred-a')?.publicKey).toEqual(fakeCrypto('cred-a').publicKey);
    expect(result.get('cred-b')?.publicKey).toEqual(fakeCrypto('cred-b').publicKey);

    const keyA = cacheKey({
      cacheVersion: CACHE_VERSION,
      cryptoFingerprint: FINGERPRINT,
      masterSecret: MASTER_SECRET,
      password: 'pw',
      credentialIdentifier: 'cred-a',
    });
    const persisted = await readCacheEntry(cacheDir, keyA);
    expect(persisted?.credentialIdentifier).toBe('cred-a');
  });

  it('handles mixed hits and misses', async () => {
    const hitCredId = 'hit-1';
    const hitPassword = 'pw';
    const hitKey = cacheKey({
      cacheVersion: CACHE_VERSION,
      cryptoFingerprint: FINGERPRINT,
      masterSecret: MASTER_SECRET,
      password: hitPassword,
      credentialIdentifier: hitCredId,
    });
    const hitCrypto = fakeCrypto(hitCredId);
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(
      cacheFilePath(cacheDir, hitKey),
      JSON.stringify(encodePersonaCrypto(hitCrypto, hitKey, hitCredId))
    );

    const { runner, calls } = makeRunner();
    const result = await ensurePersonaCrypto(
      [
        { credentialIdentifier: hitCredId, password: hitPassword },
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

  it('does not call runChunk when every miss is satisfied from cache', async () => {
    const credIds = ['a', 'b', 'c'];
    await fs.mkdir(cacheDir, { recursive: true });
    for (const credId of credIds) {
      const key = cacheKey({
        cacheVersion: CACHE_VERSION,
        cryptoFingerprint: FINGERPRINT,
        masterSecret: MASTER_SECRET,
        password: 'pw',
        credentialIdentifier: credId,
      });
      await fs.writeFile(
        cacheFilePath(cacheDir, key),
        JSON.stringify(encodePersonaCrypto(fakeCrypto(credId), key, credId))
      );
    }

    const { runner, calls } = makeRunner();
    const result = await ensurePersonaCrypto(
      credIds.map((id) => ({ credentialIdentifier: id, password: 'pw' })),
      baseOptions({ runChunk: runner })
    );
    expect(calls).toHaveLength(0);
    expect(result.size).toBe(3);
  });
});
