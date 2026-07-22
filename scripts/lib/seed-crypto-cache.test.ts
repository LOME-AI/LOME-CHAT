import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import {
  CACHE_VERSION,
  SCHEMA_VERSION,
  cacheKey,
  computeCryptoFingerprint,
  decodePersonaCrypto,
  encodePersonaCrypto,
  readCache,
  writeCache,
  type CachedPersonaCrypto,
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

function makeEntry(key: string, credentialIdentifier = 'id'): CachedPersonaCrypto {
  return encodePersonaCrypto(sampleCrypto(), key, credentialIdentifier);
}

let temporaryDir: string;
let cacheFile: string;
beforeEach(async () => {
  temporaryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'seed-crypto-cache-test-'));
  cacheFile = path.join(temporaryDir, 'seed-crypto.json');
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

describe('SCHEMA_VERSION', () => {
  it('is the numeric container-shape version (distinct from CACHE_VERSION)', () => {
    expect(SCHEMA_VERSION).toBe(1);
    expect(typeof SCHEMA_VERSION).toBe('number');
  });
});

describe('writeCache / readCache round-trip', () => {
  it('round-trips metadata and entries through disk', async () => {
    const entry = makeEntry('key-1', 'cred-1');
    await writeCache(cacheFile, {
      cacheVersion: CACHE_VERSION,
      cryptoFingerprint: 'a'.repeat(64),
      entries: new Map([['key-1', entry]]),
    });

    const read = await readCache(cacheFile);
    expect(read.cacheVersion).toBe(CACHE_VERSION);
    expect(read.cryptoFingerprint).toBe('a'.repeat(64));
    expect(read.entries.get('key-1')).toEqual(entry);
  });

  it('creates the parent directory if it does not exist', async () => {
    const nestedFile = path.join(temporaryDir, 'nested', 'deep', 'seed-crypto.json');
    await writeCache(nestedFile, {
      cacheVersion: CACHE_VERSION,
      cryptoFingerprint: 'a'.repeat(64),
      entries: new Map([['k', makeEntry('k')]]),
    });
    const read = await readCache(nestedFile);
    expect(read.entries.size).toBe(1);
  });

  it('leaves no .tmp file behind (atomic rename)', async () => {
    await writeCache(cacheFile, {
      cacheVersion: CACHE_VERSION,
      cryptoFingerprint: 'a'.repeat(64),
      entries: new Map([['k', makeEntry('k')]]),
    });
    const files = fsSync.readdirSync(temporaryDir);
    expect(files).toContain('seed-crypto.json');
    expect(files.every((f) => !f.endsWith('.tmp'))).toBe(true);
  });
});

describe('writeCache determinism', () => {
  it('serializes container with schemaVersion, pretty-print, and trailing newline', async () => {
    await writeCache(cacheFile, {
      cacheVersion: CACHE_VERSION,
      cryptoFingerprint: 'a'.repeat(64),
      entries: new Map([['k', makeEntry('k')]]),
    });
    const raw = await fs.readFile(cacheFile, 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    // Pretty-printed (2-space indent).
    expect(raw).toContain('\n  "schemaVersion": 1');
    const parsed = JSON.parse(raw) as { schemaVersion: number };
    expect(parsed.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it('emits entry keys sorted ascending regardless of insertion order', async () => {
    const forward = new Map([
      ['aaa', makeEntry('aaa')],
      ['mmm', makeEntry('mmm')],
      ['zzz', makeEntry('zzz')],
    ]);
    const reversed = new Map([
      ['zzz', makeEntry('zzz')],
      ['mmm', makeEntry('mmm')],
      ['aaa', makeEntry('aaa')],
    ]);

    await writeCache(cacheFile, {
      cacheVersion: CACHE_VERSION,
      cryptoFingerprint: 'a'.repeat(64),
      entries: forward,
    });
    const bytesForward = await fs.readFile(cacheFile, 'utf8');

    const otherFile = path.join(temporaryDir, 'other.json');
    await writeCache(otherFile, {
      cacheVersion: CACHE_VERSION,
      cryptoFingerprint: 'a'.repeat(64),
      entries: reversed,
    });
    const bytesReversed = await fs.readFile(otherFile, 'utf8');

    expect(bytesForward).toBe(bytesReversed);
    const parsed = JSON.parse(bytesForward) as { entries: Record<string, unknown> };
    expect(Object.keys(parsed.entries)).toEqual(['aaa', 'mmm', 'zzz']);
  });
});

describe('readCache corruption tolerance', () => {
  it('returns empty map + null metadata when the file does not exist', async () => {
    const read = await readCache(path.join(temporaryDir, 'missing.json'));
    expect(read).toEqual({ cacheVersion: null, cryptoFingerprint: null, entries: new Map() });
  });

  it('returns empty map + null metadata for malformed JSON', async () => {
    await fs.writeFile(cacheFile, '{not valid json');
    const read = await readCache(cacheFile);
    expect(read.cacheVersion).toBeNull();
    expect(read.cryptoFingerprint).toBeNull();
    expect(read.entries.size).toBe(0);
  });

  it('returns empty map + null metadata for the literal null', async () => {
    await fs.writeFile(cacheFile, 'null');
    const read = await readCache(cacheFile);
    expect(read.entries.size).toBe(0);
    expect(read.cacheVersion).toBeNull();
  });

  it('returns empty map for a non-object top level', async () => {
    await fs.writeFile(cacheFile, '42');
    const read = await readCache(cacheFile);
    expect(read.entries.size).toBe(0);
    expect(read.cacheVersion).toBeNull();
  });

  it('returns empty map when schemaVersion is missing', async () => {
    await fs.writeFile(
      cacheFile,
      JSON.stringify({ cacheVersion: '1', cryptoFingerprint: 'a'.repeat(64), entries: {} })
    );
    const read = await readCache(cacheFile);
    expect(read.entries.size).toBe(0);
    expect(read.cacheVersion).toBeNull();
  });

  it('returns empty map when schemaVersion mismatches', async () => {
    await fs.writeFile(
      cacheFile,
      JSON.stringify({
        schemaVersion: 999,
        cacheVersion: '1',
        cryptoFingerprint: 'a'.repeat(64),
        entries: {},
      })
    );
    const read = await readCache(cacheFile);
    expect(read.entries.size).toBe(0);
    expect(read.cacheVersion).toBeNull();
  });

  it('returns empty map when the entries object is missing', async () => {
    await fs.writeFile(
      cacheFile,
      JSON.stringify({ schemaVersion: 1, cacheVersion: '1', cryptoFingerprint: 'a'.repeat(64) })
    );
    const read = await readCache(cacheFile);
    expect(read.entries.size).toBe(0);
    expect(read.cacheVersion).toBeNull();
  });

  it('returns empty map when entries is not an object', async () => {
    await fs.writeFile(
      cacheFile,
      JSON.stringify({
        schemaVersion: 1,
        cacheVersion: '1',
        cryptoFingerprint: 'a'.repeat(64),
        entries: [1, 2, 3],
      })
    );
    const read = await readCache(cacheFile);
    expect(read.entries.size).toBe(0);
    expect(read.cacheVersion).toBeNull();
  });

  it('returns empty map when cacheVersion or cryptoFingerprint is not a string', async () => {
    await fs.writeFile(
      cacheFile,
      JSON.stringify({
        schemaVersion: 1,
        cacheVersion: 1,
        cryptoFingerprint: 'a'.repeat(64),
        entries: {},
      })
    );
    const read = await readCache(cacheFile);
    expect(read.entries.size).toBe(0);
    expect(read.cacheVersion).toBeNull();
  });
});

describe('readCache per-entry validation', () => {
  it('drops an entry whose shape is invalid while keeping a valid sibling', async () => {
    const valid = makeEntry('good-key', 'cred-good');
    await fs.writeFile(
      cacheFile,
      JSON.stringify({
        schemaVersion: 1,
        cacheVersion: '1',
        cryptoFingerprint: 'a'.repeat(64),
        entries: {
          'good-key': valid,
          'bad-key': { foo: 1 },
        },
      })
    );
    const read = await readCache(cacheFile);
    expect(read.entries.size).toBe(1);
    expect(read.entries.get('good-key')).toEqual(valid);
    expect(read.entries.has('bad-key')).toBe(false);
  });

  it('drops an entry whose internal key disagrees with its map key', async () => {
    const valid = makeEntry('matching', 'cred-1');
    const mismatched = makeEntry('internal-key', 'cred-2');
    await fs.writeFile(
      cacheFile,
      JSON.stringify({
        schemaVersion: 1,
        cacheVersion: '1',
        cryptoFingerprint: 'a'.repeat(64),
        entries: {
          matching: valid,
          'map-key': mismatched,
        },
      })
    );
    const read = await readCache(cacheFile);
    expect(read.entries.size).toBe(1);
    expect(read.entries.has('matching')).toBe(true);
    expect(read.entries.has('map-key')).toBe(false);
  });
});
