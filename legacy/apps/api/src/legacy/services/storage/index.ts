import { createMediaStorage, type MediaStorageEnv } from './media-storage.js';
import type { EvidenceConfig } from '@hushbox/db';
import type { MediaStorage } from './types.js';

export type { MediaStorage } from './types.js';
export { StorageReadError, StorageWriteError } from './types.js';
export type { MediaStorageEnv } from './media-storage.js';

/**
 * Construct the media storage client. Single codepath — MinIO in dev/CI, R2
 * in production, branched only by env config (R2_S3_ENDPOINT and credentials).
 *
 * Tests that need a stub construct one inline per-test (matching the Redis
 * stub pattern); there is no factory-level mock implementation.
 *
 * The optional `evidence` argument mirrors the AIClient + Helcim pattern:
 * when supplied, every successful storage operation records
 * `SERVICE_NAMES.R2_STORAGE` so CI's verify:evidence step can prove the
 * integration was exercised. `recordServiceEvidence` itself gates on
 * `isCI === true`, so production stays a no-op even when the config flows in.
 */
export function getMediaStorage(env: MediaStorageEnv, evidence?: EvidenceConfig): MediaStorage {
  return createMediaStorage({
    ...env,
    ...(evidence === undefined ? {} : { evidence }),
  });
}
