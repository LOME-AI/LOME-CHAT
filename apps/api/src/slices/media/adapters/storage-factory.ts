import {
  MAX_MEDIA_OBJECT_BYTES,
  MEDIA_DOWNLOAD_URL_TTL_SECONDS,
  createEnvUtilities,
} from '@hushbox/shared';
import { createR2Storage } from './storage-r2.js';
import type { EnvContext } from '@hushbox/shared';
import type { Database } from '@hushbox/db';
import type { R2NetworkOptions } from './storage-r2.js';
import type { Storage } from '../ports/index.js';

/** The R2/S3 bindings the storage adapter needs (same names the local stack sets). */
interface R2StorageEnv extends EnvContext {
  R2_S3_ENDPOINT?: string;
  R2_BUCKET_MEDIA?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
}

function requireBinding(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0) {
    throw new Error(
      `${name} is required to build the R2 storage adapter — there is no degraded mode`
    );
  }
  return value;
}

/**
 * Non-production storage retry window. Against local MinIO (dev/CI), host CPU
 * oversubscription under a full Playwright worker set produces transient
 * multi-second unavailability bursts; an idempotent PUT (last-write-wins) can
 * safely ride one out given a wide enough retry budget. This window (~8 retries
 * summing to ~16s, comfortably under the client's ~30s render deadline)
 * replaces storage-r2's fail-fast DEFAULT_NETWORK (maxRetries:2,
 * maxDelayMs:1000) — but only outside production. Production keeps
 * DEFAULT_NETWORK so a genuine R2 outage still fails fast.
 */
export const NON_PROD_STORAGE_NETWORK: Partial<R2NetworkOptions> = {
  maxRetries: 8,
  initialDelayMs: 100,
  maxDelayMs: 5000,
};

/**
 * Resolve the storage retry window for the current mode: the wider non-prod
 * window for every non-production mode (development, ciVitest, ciE2E), and
 * `undefined` in production so storage-r2's DEFAULT_NETWORK stands. Env mode is
 * decided via `createEnvUtilities`, never a bare var-existence check.
 */
export function storageNetworkForEnv(env: EnvContext): Partial<R2NetworkOptions> | undefined {
  return createEnvUtilities(env).isProduction ? undefined : NON_PROD_STORAGE_NETWORK;
}

/**
 * The composition-root R2 storage adapter, bound from env. One aws4fetch
 * codepath serves MinIO (dev/CI) and Cloudflare R2 (production), so there is no
 * mock branch — only the endpoint and credentials vary. The size cap and
 * presign TTL come from `@hushbox/shared` (the single source), and `isCI` gates
 * the service-evidence writes the adapter records after a real S3 op. Missing
 * config fails fast rather than degrading. The retry window widens outside
 * production (see `storageNetworkForEnv`) so a MinIO contention burst is ridden
 * out instead of surfacing as a spurious 503.
 */
export function createR2StorageFromEnv(env: R2StorageEnv, db: Database): Storage {
  const { isCI } = createEnvUtilities(env);
  // Omit `network` entirely in production so the adapter's DEFAULT_NETWORK
  // applies; passing `undefined` is rejected under exactOptionalPropertyTypes.
  const network = storageNetworkForEnv(env);
  return createR2Storage({
    endpoint: requireBinding(env.R2_S3_ENDPOINT, 'R2_S3_ENDPOINT'),
    bucket: requireBinding(env.R2_BUCKET_MEDIA, 'R2_BUCKET_MEDIA'),
    accessKeyId: requireBinding(env.R2_ACCESS_KEY_ID, 'R2_ACCESS_KEY_ID'),
    secretAccessKey: requireBinding(env.R2_SECRET_ACCESS_KEY, 'R2_SECRET_ACCESS_KEY'),
    maxObjectBytes: MAX_MEDIA_OBJECT_BYTES,
    defaultPresignTtlSeconds: MEDIA_DOWNLOAD_URL_TTL_SECONDS,
    db,
    isCI,
    ...(network === undefined ? {} : { network }),
  });
}
