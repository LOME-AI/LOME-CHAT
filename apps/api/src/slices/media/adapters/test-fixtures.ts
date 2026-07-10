import { AwsClient } from 'aws4fetch';
import { MAX_MEDIA_OBJECT_BYTES, MEDIA_DOWNLOAD_URL_TTL_SECONDS } from '@hushbox/shared';
import { createR2Storage } from './storage-r2.js';
import type { Database } from '@hushbox/db';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { Storage } from '../ports/index.js';

// Default: no evidence writes, so the scratch storage needs no real db. A stub
// that throws on use keeps that honest; suites asserting evidence pass a real
// db and `isCI: true` explicitly.
const NO_DB = new Proxy(
  {},
  {
    get() {
      throw new Error('scratch bucket used without an evidence db (isCI must be false)');
    },
  }
) as Database;

/**
 * Scratch-bucket scaffolding for storage-touching test suites. Age-based
 * sweeps (GC, reclaim) delete everything eligible under a prefix, so suites
 * exercising them must never share the dev bucket with other suites or with
 * a concurrent run of the same suite — each caller gets a uniquely named
 * MinIO bucket and destroys it afterwards. Lives outside *.test.ts so the
 * suites share one honest helper (the conversations test-fixtures pattern).
 */

export interface ScratchBucket {
  readonly storage: Storage;
  readonly bucket: string;
  destroy(): Promise<void>;
}

/** Awaits a Result and unwraps it — a test failure surfaces as a throw. */
export async function unwrap<T>(result: ResultAsync<T, DomainError>): Promise<T> {
  const settled = await result;
  return settled._unsafeUnwrap();
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required for storage integration tests — run via pnpm test:api`);
  }
  return value;
}

function assertOk(response: Response, operation: string): void {
  if (!response.ok) {
    throw new Error(`scratch bucket ${operation} returned ${String(response.status)}`);
  }
}

export async function createScratchBucket(
  options: { readonly db?: Database; readonly isCI?: boolean } = {}
): Promise<ScratchBucket> {
  const endpoint = requireEnv('R2_S3_ENDPOINT').replace(/\/+$/, '');
  const accessKeyId = requireEnv('R2_ACCESS_KEY_ID');
  const secretAccessKey = requireEnv('R2_SECRET_ACCESS_KEY');
  const bucket = `hushbox-scratch-${crypto.randomUUID()}`;
  const aws = new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'auto' });
  const bucketUrl = `${endpoint}/${bucket}`;

  assertOk(await aws.fetch(bucketUrl, { method: 'PUT' }), 'create');

  const storage = createR2Storage({
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    maxObjectBytes: MAX_MEDIA_OBJECT_BYTES,
    defaultPresignTtlSeconds: MEDIA_DOWNLOAD_URL_TTL_SECONDS,
    db: options.db ?? NO_DB,
    isCI: options.isCI ?? false,
  });

  return {
    storage,
    bucket,
    async destroy(): Promise<void> {
      // Re-list from the start until empty — deletes invalidate any cursor
      // anyway, and the loop handles arbitrarily large buckets.
      for (;;) {
        const page = await unwrap(storage.list(''));
        if (page.objects.length === 0) break;
        for (const object of page.objects) {
          await unwrap(storage.delete(object.key));
        }
      }
      assertOk(await aws.fetch(bucketUrl, { method: 'DELETE' }), 'delete');
    },
  };
}
