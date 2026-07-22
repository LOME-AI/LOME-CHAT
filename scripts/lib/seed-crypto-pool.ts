import * as os from 'node:os';
import {
  createAccount,
  createOpaqueClient,
  createOpaqueServer,
  finishRegistration,
  OpaqueClientConfig,
  OpaqueRegistrationRequest,
  OPAQUE_SERVER_IDENTIFIER,
  startRegistration,
} from '@hushbox/crypto';
import {
  cacheKey,
  decodePersonaCrypto,
  encodePersonaCrypto,
  readCache,
  writeCache,
  type CacheContents,
  type CachedPersonaCrypto,
  type CryptoBytes,
} from './seed-crypto-cache.js';

export interface PersonaCryptoRequest {
  credentialIdentifier: string;
  password: string;
}

export interface PersonaCryptoResult {
  credentialIdentifier: string;
  opaqueRegistration: Uint8Array;
  publicKey: Uint8Array;
  passwordWrappedPrivateKey: Uint8Array;
  recoveryWrappedPrivateKey: Uint8Array;
}

export type ChunkRunner = (
  chunk: PersonaCryptoRequest[],
  masterSecret: string
) => Promise<PersonaCryptoResult[]>;

export interface PoolOptions {
  cacheFile: string;
  cacheVersion: string;
  cryptoFingerprint: string;
  masterSecret: string;
  workerCount?: number;
  runChunk?: ChunkRunner;
}

export function chunkRequests<T>(items: T[], chunkCount: number): T[][] {
  if (items.length === 0) return [];
  const actualChunks = Math.min(chunkCount, items.length);
  const chunks: T[][] = Array.from({ length: actualChunks }, () => []);
  for (const [index, item] of items.entries()) {
    const bucket = chunks[index % actualChunks];
    /* v8 ignore next -- index % actualChunks is always a valid chunk index */
    if (bucket) bucket.push(item);
  }
  return chunks;
}

interface CacheSplit {
  hits: Map<string, CryptoBytes>;
  misses: PersonaCryptoRequest[];
  keyByCredId: Map<string, string>;
}

/**
 * Wholesale invalidation: reuse the loaded entries only when the file's stored
 * `(cacheVersion, cryptoFingerprint)` exactly matches this run's, otherwise
 * start empty so every stale entry is dropped. On a match the loaded map is
 * carried forward, so two runs against the same file accumulate.
 */
function selectEffectiveEntries(
  loaded: CacheContents,
  options: PoolOptions
): Map<string, CachedPersonaCrypto> {
  if (loaded.cacheVersion !== options.cacheVersion) return new Map();
  if (loaded.cryptoFingerprint !== options.cryptoFingerprint) return new Map();
  return loaded.entries;
}

function splitByCache(
  requests: PersonaCryptoRequest[],
  options: PoolOptions,
  effectiveEntries: Map<string, CachedPersonaCrypto>
): CacheSplit {
  const hits = new Map<string, CryptoBytes>();
  const misses: PersonaCryptoRequest[] = [];
  const keyByCredId = new Map<string, string>();

  for (const req of requests) {
    const key = cacheKey({
      cacheVersion: options.cacheVersion,
      cryptoFingerprint: options.cryptoFingerprint,
      masterSecret: options.masterSecret,
      password: req.password,
      credentialIdentifier: req.credentialIdentifier,
    });
    keyByCredId.set(req.credentialIdentifier, key);

    const cached = effectiveEntries.get(key);
    if (cached) {
      hits.set(req.credentialIdentifier, decodePersonaCrypto(cached));
    } else {
      misses.push(req);
    }
  }
  return { hits, misses, keyByCredId };
}

/**
 * Fold one computed result into the run's in-memory map. Adds to
 * `effectiveEntries` (the post-invalidation map, which may already hold other
 * calls' still-valid entries) rather than replacing it, so the eventual write
 * merges instead of clobbering.
 */
function addResult(
  result: PersonaCryptoResult,
  keyByCredId: Map<string, string>,
  effectiveEntries: Map<string, CachedPersonaCrypto>,
  hits: Map<string, CryptoBytes>
): void {
  const key = keyByCredId.get(result.credentialIdentifier);
  /* v8 ignore next 4 -- defensive: every result's credentialIdentifier originates from a keyed request */
  if (!key) {
    throw new Error(
      `seed-crypto-pool: unexpected credentialIdentifier "${result.credentialIdentifier}"`
    );
  }
  const entry = encodePersonaCrypto(
    {
      opaqueRegistration: result.opaqueRegistration,
      publicKey: result.publicKey,
      passwordWrappedPrivateKey: result.passwordWrappedPrivateKey,
      recoveryWrappedPrivateKey: result.recoveryWrappedPrivateKey,
    },
    key,
    result.credentialIdentifier
  );
  effectiveEntries.set(key, entry);
  hits.set(result.credentialIdentifier, decodePersonaCrypto(entry));
}

export async function ensurePersonaCrypto(
  requests: PersonaCryptoRequest[],
  options: PoolOptions
): Promise<Map<string, CryptoBytes>> {
  if (requests.length === 0) return new Map();

  const loaded = await readCache(options.cacheFile);
  const effectiveEntries = selectEffectiveEntries(loaded, options);
  const { hits, misses, keyByCredId } = splitByCache(requests, options, effectiveEntries);
  if (misses.length === 0) return hits;

  const chunkCount = options.workerCount ?? Math.max(1, os.cpus().length - 1);
  const chunks = chunkRequests(misses, chunkCount);
  /* v8 ignore next -- the default runner (real OPAQUE worker crypto) is exercised by the seed run, not unit tests */
  const runChunk = options.runChunk ?? defaultRunChunk;

  const chunkResults = await Promise.all(
    chunks.map((chunk) => runChunk(chunk, options.masterSecret))
  );

  // The written map is the post-invalidation effective map plus this run's new
  // entries — never only this run's keys — so still-valid siblings from other
  // calls survive the rewrite.
  for (const result of chunkResults.flat()) {
    addResult(result, keyByCredId, effectiveEntries, hits);
  }

  await writeCache(options.cacheFile, {
    cacheVersion: options.cacheVersion,
    cryptoFingerprint: options.cryptoFingerprint,
    entries: effectiveEntries,
  });

  return hits;
}

/* v8 ignore start -- exercised via integration runs of seed:cache, not unit tests */
let cachedOpaqueServer: {
  masterSecret: string;
  server: Awaited<ReturnType<typeof createOpaqueServer>>;
} | null = null;

async function getSharedOpaqueServer(
  masterSecret: string
): Promise<Awaited<ReturnType<typeof createOpaqueServer>>> {
  if (cachedOpaqueServer?.masterSecret === masterSecret) {
    return cachedOpaqueServer.server;
  }
  const masterSecretBytes = new TextEncoder().encode(masterSecret);
  const server = await createOpaqueServer(masterSecretBytes, OPAQUE_SERVER_IDENTIFIER);
  cachedOpaqueServer = { masterSecret, server };
  return server;
}

async function generateOne(
  req: PersonaCryptoRequest,
  masterSecret: string
): Promise<PersonaCryptoResult> {
  const opaqueServer = await getSharedOpaqueServer(masterSecret);
  const client = createOpaqueClient();
  const { serialized } = await startRegistration(client, req.password);

  const request = OpaqueRegistrationRequest.deserialize(OpaqueClientConfig, serialized);
  const serverResult = await opaqueServer.registerInit(request, req.credentialIdentifier);
  if (serverResult instanceof Error) throw serverResult;

  const { record, exportKey } = await finishRegistration(
    client,
    serverResult.serialize(),
    OPAQUE_SERVER_IDENTIFIER
  );

  const account = await createAccount(new Uint8Array(exportKey));

  return {
    credentialIdentifier: req.credentialIdentifier,
    opaqueRegistration: new Uint8Array(record),
    publicKey: account.publicKey,
    passwordWrappedPrivateKey: account.passwordWrappedPrivateKey,
    recoveryWrappedPrivateKey: account.recoveryWrappedPrivateKey,
  };
}

const defaultRunChunk: ChunkRunner = async (chunk, masterSecret) =>
  Promise.all(chunk.map((req) => generateOne(req, masterSecret)));
/* v8 ignore stop */
