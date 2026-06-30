import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import path from 'node:path';
import { DEV_PERSONAS, MOBILE_TEST_PERSONA, TEST_PERSONAS, seedUUID } from './legacy_seed.js';
import { DEV_PASSWORD } from '@hushbox/shared';
import {
  cacheKey,
  cacheFilePath,
  CACHE_VERSION,
  encodePersonaCrypto,
} from './lib/legacy_seed-crypto-cache.js';
import { enumerateAllPersonaRequests, refreshCache } from './legacy_seed-cache.js';

const MASTER_SECRET = 'dev-master-secret';

function bytes(n: number, fill: number): Uint8Array {
  return new Uint8Array(n).fill(fill);
}

function fakeCrypto(credId: string) {
  return {
    credentialIdentifier: credId,
    opaqueRegistration: bytes(192, 0xab),
    publicKey: bytes(32, 0xcd),
    passwordWrappedPrivateKey: bytes(48, 0xef),
    recoveryWrappedPrivateKey: bytes(48, 0x12),
  };
}

let cacheDir: string;
let cryptoDir: string;
beforeEach(async () => {
  cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'seed-cache-test-cache-'));
  cryptoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'seed-cache-test-crypto-'));
  await fs.writeFile(path.join(cryptoDir, 'index.ts'), 'export const x = 1;');
});
afterEach(async () => {
  await fs.rm(cacheDir, { recursive: true, force: true });
  await fs.rm(cryptoDir, { recursive: true, force: true });
});

describe('enumerateAllPersonaRequests', () => {
  it('includes one entry per DEV_PERSONA', () => {
    const requests = enumerateAllPersonaRequests();
    for (const persona of DEV_PERSONAS) {
      const expectedId = seedUUID(`dev-user-${persona.name}`);
      expect(requests.map((r) => r.credentialIdentifier)).toContain(expectedId);
    }
  });

  it('includes one entry per TEST_PERSONA', () => {
    const requests = enumerateAllPersonaRequests();
    for (const persona of TEST_PERSONAS) {
      const expectedId = seedUUID(`test-user-${persona.name}`);
      expect(requests.map((r) => r.credentialIdentifier)).toContain(expectedId);
    }
  });

  it('includes the MOBILE_TEST_PERSONA', () => {
    const requests = enumerateAllPersonaRequests();
    const expectedId = seedUUID(`test-user-${MOBILE_TEST_PERSONA.name}`);
    expect(requests.map((r) => r.credentialIdentifier)).toContain(expectedId);
  });

  it('uses DEV_PASSWORD for every persona', () => {
    const requests = enumerateAllPersonaRequests();
    expect(requests.every((r) => r.password === DEV_PASSWORD)).toBe(true);
  });

  it('produces no duplicate credentialIdentifiers', () => {
    const requests = enumerateAllPersonaRequests();
    const ids = requests.map((r) => r.credentialIdentifier);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('total count equals DEV_PERSONAS + TEST_PERSONAS + MOBILE_TEST_PERSONA', () => {
    const requests = enumerateAllPersonaRequests();
    expect(requests).toHaveLength(DEV_PERSONAS.length + TEST_PERSONAS.length + 1);
  });
});

describe('refreshCache', () => {
  it('reports hits and misses', async () => {
    const runner = vi.fn((chunk: { credentialIdentifier: string; password: string }[]) =>
      Promise.resolve(chunk.map((r) => fakeCrypto(r.credentialIdentifier)))
    );
    const result = await refreshCache({
      cacheDir,
      cryptoDir,
      masterSecret: MASTER_SECRET,
      runChunk: runner,
      workerCount: 1,
    });

    const totalPersonas = DEV_PERSONAS.length + TEST_PERSONAS.length + 1;
    expect(result.total).toBe(totalPersonas);
    expect(result.hits).toBe(0);
    expect(result.misses).toBe(totalPersonas);
    expect(runner).toHaveBeenCalled();
  });

  it('reports all hits when cache is hot', async () => {
    const requests = enumerateAllPersonaRequests();
    const cryptoFingerprint = await import('./lib/legacy_seed-crypto-cache.js').then((m) =>
      m.computeCryptoFingerprint(cryptoDir)
    );

    for (const req of requests) {
      const key = cacheKey({
        cacheVersion: CACHE_VERSION,
        cryptoFingerprint,
        masterSecret: MASTER_SECRET,
        password: req.password,
        credentialIdentifier: req.credentialIdentifier,
      });
      await fs.writeFile(
        cacheFilePath(cacheDir, key),
        JSON.stringify(
          encodePersonaCrypto(fakeCrypto(req.credentialIdentifier), key, req.credentialIdentifier)
        )
      );
    }

    const runner = vi.fn();
    const result = await refreshCache({
      cacheDir,
      cryptoDir,
      masterSecret: MASTER_SECRET,
      runChunk: runner,
      workerCount: 1,
    });
    expect(result.hits).toBe(requests.length);
    expect(result.misses).toBe(0);
    expect(runner).not.toHaveBeenCalled();
  });
});
