import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import {
  CACHE_VERSION,
  cacheFilePath,
  cacheKey,
  computeCryptoFingerprint,
  decodePersonaCrypto,
  encodePersonaCrypto,
  readCacheEntry,
  writeCacheEntry,
} from './seed-crypto-cache.js';

const sampleInput = {
  cacheVersion: CACHE_VERSION,
  cryptoFingerprint: 'a'.repeat(64),
  masterSecret: 'dev-master-secret',
  password: 'password123',
  credentialIdentifier: '00000000-0000-4000-8000-000000000001',
};

function bytes(n: number, fill: number): Uint8Array {
  return new Uint8Array(n).fill(fill);
}

function sampleCrypto() {
  return {
    opaqueRegistration: bytes(192, 0xab),
    publicKey: bytes(32, 0xcd),
    passwordWrappedPrivateKey: bytes(48, 0xef),
    recoveryWrappedPrivateKey: bytes(48, 0x12),
  };
}

let temporaryDir: string;
beforeEach(async () => {
  temporaryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'seed-crypto-cache-test-'));
});
afterEach(async () => {
  await fs.rm(temporaryDir, { recursive: true, force: true });
});

describe('cacheKey', () => {
  it('returns 64-char hex sha256', () => {
    const key = cacheKey(sampleInput);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for identical inputs', () => {
    expect(cacheKey(sampleInput)).toBe(cacheKey(sampleInput));
  });

  it('changes when cacheVersion changes', () => {
    expect(cacheKey({ ...sampleInput, cacheVersion: '2' })).not.toBe(cacheKey(sampleInput));
  });

  it('changes when cryptoFingerprint changes', () => {
    expect(cacheKey({ ...sampleInput, cryptoFingerprint: 'b'.repeat(64) })).not.toBe(
      cacheKey(sampleInput)
    );
  });

  it('changes when masterSecret changes', () => {
    expect(cacheKey({ ...sampleInput, masterSecret: 'different' })).not.toBe(cacheKey(sampleInput));
  });

  it('changes when password changes', () => {
    expect(cacheKey({ ...sampleInput, password: 'different' })).not.toBe(cacheKey(sampleInput));
  });

  it('changes when credentialIdentifier changes', () => {
    expect(
      cacheKey({ ...sampleInput, credentialIdentifier: '00000000-0000-4000-8000-000000000002' })
    ).not.toBe(cacheKey(sampleInput));
  });

  it('does not collide on field boundary ambiguity', () => {
    const a = cacheKey({ ...sampleInput, masterSecret: 'abc', password: 'def' });
    const b = cacheKey({ ...sampleInput, masterSecret: 'ab', password: 'cdef' });
    expect(a).not.toBe(b);
  });
});

describe('computeCryptoFingerprint', () => {
  it('returns 64-char hex sha256', async () => {
    fsSync.writeFileSync(path.join(temporaryDir, 'a.ts'), 'export const a = 1;');
    const fingerprint = await computeCryptoFingerprint(temporaryDir);
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for identical directory contents', async () => {
    fsSync.writeFileSync(path.join(temporaryDir, 'a.ts'), 'export const a = 1;');
    fsSync.writeFileSync(path.join(temporaryDir, 'b.ts'), 'export const b = 2;');
    const first = await computeCryptoFingerprint(temporaryDir);
    const second = await computeCryptoFingerprint(temporaryDir);
    expect(first).toBe(second);
  });

  it('changes when a file content changes', async () => {
    fsSync.writeFileSync(path.join(temporaryDir, 'a.ts'), 'export const a = 1;');
    const before = await computeCryptoFingerprint(temporaryDir);
    fsSync.writeFileSync(path.join(temporaryDir, 'a.ts'), 'export const a = 2;');
    const after = await computeCryptoFingerprint(temporaryDir);
    expect(before).not.toBe(after);
  });

  it('changes when a file is added', async () => {
    fsSync.writeFileSync(path.join(temporaryDir, 'a.ts'), 'export const a = 1;');
    const before = await computeCryptoFingerprint(temporaryDir);
    fsSync.writeFileSync(path.join(temporaryDir, 'b.ts'), 'export const b = 2;');
    const after = await computeCryptoFingerprint(temporaryDir);
    expect(before).not.toBe(after);
  });

  it('changes when a file is removed', async () => {
    fsSync.writeFileSync(path.join(temporaryDir, 'a.ts'), 'export const a = 1;');
    fsSync.writeFileSync(path.join(temporaryDir, 'b.ts'), 'export const b = 2;');
    const before = await computeCryptoFingerprint(temporaryDir);
    fsSync.unlinkSync(path.join(temporaryDir, 'b.ts'));
    const after = await computeCryptoFingerprint(temporaryDir);
    expect(before).not.toBe(after);
  });

  it('recurses into subdirectories', async () => {
    fsSync.mkdirSync(path.join(temporaryDir, 'sub'));
    fsSync.writeFileSync(path.join(temporaryDir, 'sub', 'a.ts'), 'export const a = 1;');
    const before = await computeCryptoFingerprint(temporaryDir);
    fsSync.writeFileSync(path.join(temporaryDir, 'sub', 'a.ts'), 'export const a = 2;');
    const after = await computeCryptoFingerprint(temporaryDir);
    expect(before).not.toBe(after);
  });

  it('ignores non-source files (.test.ts, .d.ts, dist/)', async () => {
    fsSync.writeFileSync(path.join(temporaryDir, 'a.ts'), 'export const a = 1;');
    const baseline = await computeCryptoFingerprint(temporaryDir);
    fsSync.writeFileSync(path.join(temporaryDir, 'a.test.ts'), 'test stuff');
    fsSync.writeFileSync(path.join(temporaryDir, 'a.d.ts'), 'declare ...');
    fsSync.mkdirSync(path.join(temporaryDir, 'dist'));
    fsSync.writeFileSync(path.join(temporaryDir, 'dist', 'a.js'), 'compiled');
    const after = await computeCryptoFingerprint(temporaryDir);
    expect(after).toBe(baseline);
  });

  it('is path-order stable (filenames sorted)', async () => {
    fsSync.writeFileSync(path.join(temporaryDir, 'z.ts'), 'export const z = 1;');
    fsSync.writeFileSync(path.join(temporaryDir, 'a.ts'), 'export const a = 1;');
    const first = await computeCryptoFingerprint(temporaryDir);

    const temporaryDir2 = await fs.mkdtemp(path.join(os.tmpdir(), 'seed-crypto-cache-test-'));
    fsSync.writeFileSync(path.join(temporaryDir2, 'a.ts'), 'export const a = 1;');
    fsSync.writeFileSync(path.join(temporaryDir2, 'z.ts'), 'export const z = 1;');
    const second = await computeCryptoFingerprint(temporaryDir2);

    expect(first).toBe(second);
    await fs.rm(temporaryDir2, { recursive: true, force: true });
  });
});

describe('encodePersonaCrypto / decodePersonaCrypto', () => {
  it('round-trips identical bytes', () => {
    const original = sampleCrypto();
    const key = cacheKey(sampleInput);
    const encoded = encodePersonaCrypto(original, key, sampleInput.credentialIdentifier);
    const decoded = decodePersonaCrypto(encoded);
    expect(decoded.opaqueRegistration).toEqual(original.opaqueRegistration);
    expect(decoded.publicKey).toEqual(original.publicKey);
    expect(decoded.passwordWrappedPrivateKey).toEqual(original.passwordWrappedPrivateKey);
    expect(decoded.recoveryWrappedPrivateKey).toEqual(original.recoveryWrappedPrivateKey);
  });

  it('encodes byte arrays as base64 strings', () => {
    const encoded = encodePersonaCrypto(sampleCrypto(), 'k', 'id');
    expect(typeof encoded.opaqueRegistration).toBe('string');
    expect(encoded.opaqueRegistration).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it('preserves the key and credentialIdentifier verbatim', () => {
    const encoded = encodePersonaCrypto(sampleCrypto(), 'somekey', 'someid');
    expect(encoded.key).toBe('somekey');
    expect(encoded.credentialIdentifier).toBe('someid');
  });
});

describe('cacheFilePath', () => {
  it('joins cache dir with key + .json', () => {
    const dir = path.join(os.tmpdir(), 'cache');
    expect(cacheFilePath(dir, 'deadbeef')).toBe(path.join(dir, 'deadbeef.json'));
  });
});

describe('readCacheEntry / writeCacheEntry', () => {
  it('round-trips an entry through disk', async () => {
    const key = cacheKey(sampleInput);
    const entry = encodePersonaCrypto(sampleCrypto(), key, sampleInput.credentialIdentifier);
    await writeCacheEntry(temporaryDir, entry);
    const read = await readCacheEntry(temporaryDir, key);
    expect(read).toEqual(entry);
  });

  it('returns null when file does not exist', async () => {
    const read = await readCacheEntry(temporaryDir, 'missingkey');
    expect(read).toBeNull();
  });

  it('returns null when JSON is malformed', async () => {
    const key = 'bogus';
    await fs.writeFile(path.join(temporaryDir, `${key}.json`), '{not valid json');
    const read = await readCacheEntry(temporaryDir, key);
    expect(read).toBeNull();
  });

  it('returns null when the stored key does not match the requested key', async () => {
    const entry = encodePersonaCrypto(sampleCrypto(), 'tamperedkey', 'id');
    await writeCacheEntry(temporaryDir, entry);
    const read = await readCacheEntry(temporaryDir, 'differentkey');
    expect(read).toBeNull();
  });

  it('creates the cache directory if it does not exist', async () => {
    const nestedDir = path.join(temporaryDir, 'nested', 'cache');
    const key = cacheKey(sampleInput);
    const entry = encodePersonaCrypto(sampleCrypto(), key, sampleInput.credentialIdentifier);
    await writeCacheEntry(nestedDir, entry);
    const read = await readCacheEntry(nestedDir, key);
    expect(read).toEqual(entry);
  });

  it('writes atomically (no partial file visible on concurrent read)', async () => {
    const key = cacheKey(sampleInput);
    const entry = encodePersonaCrypto(sampleCrypto(), key, sampleInput.credentialIdentifier);
    await writeCacheEntry(temporaryDir, entry);
    const files = fsSync.readdirSync(temporaryDir);
    expect(files).toContain(`${key}.json`);
    expect(files.every((f) => !f.endsWith('.tmp'))).toBe(true);
  });
});
