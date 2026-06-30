import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Bump to force-invalidate every cache entry without changing crypto code.
 * Escape hatch — normal invalidation happens via the crypto fingerprint.
 */
export const CACHE_VERSION = '1';

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

export function cacheFilePath(cacheDir: string, key: string): string {
  return path.join(cacheDir, `${key}.json`);
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

export async function readCacheEntry(
  cacheDir: string,
  key: string
): Promise<CachedPersonaCrypto | null> {
  const file = cacheFilePath(cacheDir, key);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isCachedPersonaCrypto(parsed)) return null;
  if (parsed.key !== key) return null;
  return parsed;
}

export async function writeCacheEntry(cacheDir: string, entry: CachedPersonaCrypto): Promise<void> {
  await fs.mkdir(cacheDir, { recursive: true });
  const finalPath = cacheFilePath(cacheDir, entry.key);
  const temporaryPath = `${finalPath}.${process.pid.toString()}.${Date.now().toString()}.tmp`;
  // Pretty-print so PR diffs are reviewable when crypto changes.
  await fs.writeFile(temporaryPath, `${JSON.stringify(entry, null, 2)}\n`, 'utf8');
  await fs.rename(temporaryPath, finalPath);
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
