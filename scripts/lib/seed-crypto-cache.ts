import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Bump to force-invalidate every cache entry without changing crypto code.
 * Escape hatch — normal invalidation happens via the crypto fingerprint.
 */
export const CACHE_VERSION = '1';

/**
 * On-disk container-shape version for `scripts/.cache/seed-crypto.json`. Bump
 * only when the file's top-level structure changes; `readCache` treats any
 * other value as an unreadable (fully invalidated) cache. Distinct from
 * `CACHE_VERSION`, which invalidates entries without changing the container.
 */
export const SCHEMA_VERSION = 1;

export interface CacheKeyInput {
  cacheVersion: string;
  cryptoFingerprint: string;
  masterSecret: string;
  password: string;
  credentialIdentifier: string;
}

export interface CryptoBytes {
  opaqueRegistration: Uint8Array;
  publicKey: Uint8Array;
  passwordWrappedPrivateKey: Uint8Array;
  recoveryWrappedPrivateKey: Uint8Array;
}

export interface CachedPersonaCrypto {
  key: string;
  credentialIdentifier: string;
  opaqueRegistration: string;
  publicKey: string;
  passwordWrappedPrivateKey: string;
  recoveryWrappedPrivateKey: string;
}

/**
 * NUL is illegal in every input here (fingerprints are hex, ids are UUIDs,
 * secrets/passwords are dev constants with no control chars), so it's a safe
 * boundary marker that prevents "abc|def" colliding with "ab|cdef".
 */
const FIELD_SEP = '\0';

export function cacheKey(input: CacheKeyInput): string {
  const hash = crypto.createHash('sha256');
  hash.update(input.cacheVersion);
  hash.update(FIELD_SEP);
  hash.update(input.cryptoFingerprint);
  hash.update(FIELD_SEP);
  hash.update(crypto.createHash('sha256').update(input.masterSecret).digest('hex'));
  hash.update(FIELD_SEP);
  hash.update(crypto.createHash('sha256').update(input.password).digest('hex'));
  hash.update(FIELD_SEP);
  hash.update(input.credentialIdentifier);
  return hash.digest('hex');
}

/**
 * Order-stable SHA-256 over `<relative-path>:<sha256-of-content>` lines for
 * every `.ts` source file under `dir` (excluding `.test.ts`, `.d.ts`, and any
 * `dist/`). Filenames are sorted so two clones produce identical output.
 */
export async function computeCryptoFingerprint(dir: string): Promise<string> {
  const files = await collectSourceFiles(dir);
  files.sort((a, b) => a.localeCompare(b));
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    const relative = path.relative(dir, file);
    const content = await fs.readFile(file);
    const fileHash = crypto.createHash('sha256').update(content).digest('hex');
    hash.update(`${relative}:${fileHash}\n`);
  }
  return hash.digest('hex');
}

function isSourceFile(name: string): boolean {
  return name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts');
}

async function collectSourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'dist' || entry.name === 'node_modules') continue;
      out.push(...(await collectSourceFiles(full)));
    } else if (entry.isFile() && isSourceFile(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

export function encodePersonaCrypto(
  bytes: CryptoBytes,
  key: string,
  credentialIdentifier: string
): CachedPersonaCrypto {
  return {
    key,
    credentialIdentifier,
    opaqueRegistration: toBase64(bytes.opaqueRegistration),
    publicKey: toBase64(bytes.publicKey),
    passwordWrappedPrivateKey: toBase64(bytes.passwordWrappedPrivateKey),
    recoveryWrappedPrivateKey: toBase64(bytes.recoveryWrappedPrivateKey),
  };
}

export function decodePersonaCrypto(entry: CachedPersonaCrypto): CryptoBytes {
  return {
    opaqueRegistration: fromBase64(entry.opaqueRegistration),
    publicKey: fromBase64(entry.publicKey),
    passwordWrappedPrivateKey: fromBase64(entry.passwordWrappedPrivateKey),
    recoveryWrappedPrivateKey: fromBase64(entry.recoveryWrappedPrivateKey),
  };
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function fromBase64(encoded: string): Uint8Array {
  return new Uint8Array(Buffer.from(encoded, 'base64'));
}

export interface CacheContents {
  cacheVersion: string | null;
  cryptoFingerprint: string | null;
  entries: Map<string, CachedPersonaCrypto>;
}

function emptyCache(): CacheContents {
  return { cacheVersion: null, cryptoFingerprint: null, entries: new Map() };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface ValidContainer {
  cacheVersion: string;
  cryptoFingerprint: string;
  entries: Record<string, unknown>;
}

/**
 * Validate the file's top-level container shape. Returns null for anything that
 * isn't a plain object with the current `schemaVersion`, string metadata, and a
 * plain `entries` object — the caller turns null into a full miss.
 */
function parseContainer(raw: string): ValidContainer | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  if (parsed['schemaVersion'] !== SCHEMA_VERSION) return null;
  if (typeof parsed['cacheVersion'] !== 'string') return null;
  if (typeof parsed['cryptoFingerprint'] !== 'string') return null;
  const entries = parsed['entries'];
  if (!isPlainObject(entries)) return null;
  return {
    cacheVersion: parsed['cacheVersion'],
    cryptoFingerprint: parsed['cryptoFingerprint'],
    entries,
  };
}

/**
 * Read and parse the single whole-file cache. Never throws: any failure —
 * missing file, bad JSON, JSON `null`, or a top-level shape that isn't a valid
 * container (wrong/absent `schemaVersion`, non-string metadata, missing
 * `entries` object) — yields an empty cache with null metadata (a full miss).
 * Individual entries are dropped if they fail `isCachedPersonaCrypto` or if
 * their stored `key` disagrees with their map key; valid siblings are kept.
 */
export async function readCache(cacheFile: string): Promise<CacheContents> {
  let raw: string;
  try {
    raw = await fs.readFile(cacheFile, 'utf8');
  } catch {
    return emptyCache();
  }
  const container = parseContainer(raw);
  if (container === null) return emptyCache();

  const entries = new Map<string, CachedPersonaCrypto>();
  for (const [mapKey, value] of Object.entries(container.entries)) {
    if (isCachedPersonaCrypto(value) && value.key === mapKey) {
      entries.set(mapKey, value);
    }
  }
  return {
    cacheVersion: container.cacheVersion,
    cryptoFingerprint: container.cryptoFingerprint,
    entries,
  };
}

export async function writeCache(
  cacheFile: string,
  data: {
    cacheVersion: string;
    cryptoFingerprint: string;
    entries: Map<string, CachedPersonaCrypto>;
  }
): Promise<void> {
  await fs.mkdir(path.dirname(cacheFile), { recursive: true });
  // Keys sorted ascending + pretty-print + trailing newline so PR diffs stay
  // reviewable and byte-stable regardless of the in-memory insertion order.
  const sortedEntries = [...data.entries.entries()].toSorted(([a], [b]) => a.localeCompare(b));
  const container = {
    schemaVersion: SCHEMA_VERSION,
    cacheVersion: data.cacheVersion,
    cryptoFingerprint: data.cryptoFingerprint,
    entries: Object.fromEntries(sortedEntries),
  };
  // Concurrent-seed last-write-wins is a deliberate tradeoff: two seed
  // processes racing on this single file may clobber each other, and a lost
  // entry simply recomputes on the next run. Accepted per founder ruling — no
  // locking or read-merge-on-write is attempted here.
  const temporaryPath = `${cacheFile}.${process.pid.toString()}.${Date.now().toString()}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(container, null, 2)}\n`, 'utf8');
  await fs.rename(temporaryPath, cacheFile);
}

function isCachedPersonaCrypto(value: unknown): value is CachedPersonaCrypto {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['key'] === 'string' &&
    typeof v['credentialIdentifier'] === 'string' &&
    typeof v['opaqueRegistration'] === 'string' &&
    typeof v['publicKey'] === 'string' &&
    typeof v['passwordWrappedPrivateKey'] === 'string' &&
    typeof v['recoveryWrappedPrivateKey'] === 'string'
  );
}
