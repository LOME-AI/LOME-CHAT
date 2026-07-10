import {
  MAX_MEDIA_OBJECT_BYTES,
  MEDIA_DOWNLOAD_URL_TTL_SECONDS,
  createEnvUtilities,
} from '@hushbox/shared';
import { createR2Storage } from './storage-r2.js';
import type { EnvContext } from '@hushbox/shared';
import type { Database } from '@hushbox/db';
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
 * The composition-root R2 storage adapter, bound from env. One aws4fetch
 * codepath serves MinIO (dev/CI) and Cloudflare R2 (production), so there is no
 * mock branch — only the endpoint and credentials vary. The size cap and
 * presign TTL come from `@hushbox/shared` (the single source), and `isCI` gates
 * the service-evidence writes the adapter records after a real S3 op. Missing
 * config fails fast rather than degrading.
 */
export function createR2StorageFromEnv(env: R2StorageEnv, db: Database): Storage {
  const { isCI } = createEnvUtilities(env);
  return createR2Storage({
    endpoint: requireBinding(env.R2_S3_ENDPOINT, 'R2_S3_ENDPOINT'),
    bucket: requireBinding(env.R2_BUCKET_MEDIA, 'R2_BUCKET_MEDIA'),
    accessKeyId: requireBinding(env.R2_ACCESS_KEY_ID, 'R2_ACCESS_KEY_ID'),
    secretAccessKey: requireBinding(env.R2_SECRET_ACCESS_KEY, 'R2_SECRET_ACCESS_KEY'),
    maxObjectBytes: MAX_MEDIA_OBJECT_BYTES,
    defaultPresignTtlSeconds: MEDIA_DOWNLOAD_URL_TTL_SECONDS,
    db,
    isCI,
  });
}
