import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEV_PASSWORD, envConfig, Mode, resolveRaw } from '@hushbox/shared';
import { isMainModule } from './lib/is-main.js';
import { runMain } from './lib/run-main.js';
import {
  cacheKey,
  CACHE_VERSION,
  computeCryptoFingerprint,
  readCacheEntry,
} from './lib/legacy_seed-crypto-cache.js';
import {
  ensurePersonaCrypto,
  type ChunkRunner,
  type PersonaCryptoRequest,
} from './lib/legacy_seed-crypto-pool.js';
import { DEV_PERSONAS, MOBILE_TEST_PERSONA, TEST_PERSONAS, seedUUID } from './legacy_seed.js';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPTS_DIR, '..');

export const DEFAULT_CACHE_DIR = path.join(REPO_ROOT, 'scripts', '.cache', 'seed-crypto');
export const DEFAULT_CRYPTO_DIR = path.join(REPO_ROOT, 'packages', 'crypto', 'src');

export function enumerateAllPersonaRequests(): PersonaCryptoRequest[] {
  return [
    ...DEV_PERSONAS.map((persona) => ({
      credentialIdentifier: seedUUID(`dev-user-${persona.name}`),
      password: DEV_PASSWORD,
    })),
    ...TEST_PERSONAS.map((persona) => ({
      credentialIdentifier: seedUUID(`test-user-${persona.name}`),
      password: DEV_PASSWORD,
    })),
    {
      credentialIdentifier: seedUUID(`test-user-${MOBILE_TEST_PERSONA.name}`),
      password: DEV_PASSWORD,
    },
  ];
}

export interface RefreshCacheResult {
  hits: number;
  misses: number;
  total: number;
}

export interface RefreshCacheOptions {
  cacheDir: string;
  cryptoDir: string;
  masterSecret: string;
  runChunk?: ChunkRunner;
  workerCount?: number;
}

export async function refreshCache(options: RefreshCacheOptions): Promise<RefreshCacheResult> {
  const cryptoFingerprint = await computeCryptoFingerprint(options.cryptoDir);
  const requests = enumerateAllPersonaRequests();

  let hits = 0;
  for (const req of requests) {
    const key = cacheKey({
      cacheVersion: CACHE_VERSION,
      cryptoFingerprint,
      masterSecret: options.masterSecret,
      password: req.password,
      credentialIdentifier: req.credentialIdentifier,
    });
    if (await readCacheEntry(options.cacheDir, key)) hits++;
  }

  await ensurePersonaCrypto(requests, {
    cacheDir: options.cacheDir,
    cacheVersion: CACHE_VERSION,
    cryptoFingerprint,
    masterSecret: options.masterSecret,
    ...(options.runChunk !== undefined && { runChunk: options.runChunk }),
    ...(options.workerCount !== undefined && { workerCount: options.workerCount }),
  });

  return { hits, misses: requests.length - hits, total: requests.length };
}

/* v8 ignore start -- CLI entry point exercised via package.json scripts */
function resolveOpaqueMasterSecret(): string {
  const fromEnv = process.env['OPAQUE_MASTER_SECRET'];
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return resolveRaw(envConfig.OPAQUE_MASTER_SECRET, Mode.Development) as string;
}

if (isMainModule(import.meta.url)) {
  await runMain(async () => {
    const masterSecret = resolveOpaqueMasterSecret();
    const startTime = Date.now();
    const result = await refreshCache({
      cacheDir: DEFAULT_CACHE_DIR,
      cryptoDir: DEFAULT_CRYPTO_DIR,
      masterSecret,
    });
    const elapsedMs = Date.now() - startTime;
    const elapsed =
      elapsedMs < 1000 ? `${String(elapsedMs)}ms` : `${(elapsedMs / 1000).toFixed(1)}s`;
    console.log(
      `seed:cache: ${String(result.hits)}/${String(result.total)} hot, ` +
        `${String(result.misses)} regenerated in ${elapsed}`
    );
  });
}
/* v8 ignore stop */
