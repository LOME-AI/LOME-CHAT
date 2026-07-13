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
  readCacheEntry,
  writeCacheEntry,
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
  cacheDir: string;
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
    if (bucket) bucket.push(item);
  }
  return chunks;
}

interface CacheSplit {
  hits: Map<string, CryptoBytes>;
  misses: PersonaCryptoRequest[];
  keyByCredId: Map<string, string>;
}

async function splitByCache(
  requests: PersonaCryptoRequest[],
  options: PoolOptions
): Promise<CacheSplit> {
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

    const cached = await readCacheEntry(options.cacheDir, key);
    if (cached) {
      hits.set(req.credentialIdentifier, decodePersonaCrypto(cached));
    } else {
      misses.push(req);
    }
  }
  return { hits, misses, keyByCredId };
}

async function persistResult(
  result: PersonaCryptoResult,
  keyByCredId: Map<string, string>,
  cacheDir: string
): Promise<CryptoBytes> {
  const key = keyByCredId.get(result.credentialIdentifier);
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
  await writeCacheEntry(cacheDir, entry);
  return decodePersonaCrypto(entry);
}

export async function ensurePersonaCrypto(
  requests: PersonaCryptoRequest[],
  options: PoolOptions
): Promise<Map<string, CryptoBytes>> {
  if (requests.length === 0) return new Map();

  const { hits, misses, keyByCredId } = await splitByCache(requests, options);
  if (misses.length === 0) return hits;

  const chunkCount = options.workerCount ?? Math.max(1, os.cpus().length - 1);
  const chunks = chunkRequests(misses, chunkCount);
  const runChunk = options.runChunk ?? defaultRunChunk;

  const chunkResults = await Promise.all(
    chunks.map((chunk) => runChunk(chunk, options.masterSecret))
  );

  for (const chunkResult of chunkResults) {
    for (const result of chunkResult) {
      hits.set(
        result.credentialIdentifier,
        await persistResult(result, keyByCredId, options.cacheDir)
      );
    }
  }

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
