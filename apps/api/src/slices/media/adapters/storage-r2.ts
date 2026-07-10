import { AwsClient } from 'aws4fetch';
import { SERVICE_NAMES, recordServiceEvidence } from '@hushbox/db';
import { errAsync, fromPromise } from '../../../lib/result/index.js';
import { unavailableError, validationError } from '../../../lib/errors/index.js';
import { retryWithTimeoutPolicy } from '../../../lib/resilience/index.js';
import { validateMediaKey, validateStagingBinding } from '../ports/index.js';
import { parseListObjectsV2Response } from './list-xml.js';
import type { Database } from '@hushbox/db';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type {
  ListOptions,
  ListPage,
  ObjectStat,
  PresignedGet,
  PutOptions,
  Storage,
} from '../ports/index.js';

/**
 * Storage adapter: one aws4fetch S3 codepath for MinIO (dev/CI) and
 * Cloudflare R2 (production); endpoint and credentials are the only
 * environment-specific config. Single-PUT only — multipart upload is not
 * implemented; payloads over the configured cap are rejected at write.
 *
 * Size cap and default presign TTL are injected, not imported: the wiring
 * passes MAX_MEDIA_OBJECT_BYTES / MEDIA_DOWNLOAD_URL_TTL_SECONDS from
 * @hushbox/shared (the pinned single source of those values).
 *
 * All five S3 operations here are idempotent (PUT is last-write-wins,
 * DELETE succeeds on missing keys), so the retry policy is safe.
 */

export interface R2NetworkOptions {
  readonly maxRetries: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly timeoutMs: number;
}

export interface R2StorageConfig {
  readonly endpoint: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Single-PUT size cap in bytes (wiring passes MAX_MEDIA_OBJECT_BYTES). */
  readonly maxObjectBytes: number;
  /** Default presign TTL (wiring passes MEDIA_DOWNLOAD_URL_TTL_SECONDS). */
  readonly defaultPresignTtlSeconds: number;
  /**
   * Evidence writes go through `recordServiceEvidence` (CI-only inside): a
   * successful real PUT records an `r2-storage` row so CI's `verify:evidence`
   * step can prove the real S3 seam was exercised.
   */
  readonly db: Database;
  readonly isCI: boolean;
  readonly network?: Partial<R2NetworkOptions>;
}

const DEFAULT_NETWORK: R2NetworkOptions = {
  maxRetries: 2,
  initialDelayMs: 100,
  maxDelayMs: 1000,
  timeoutMs: 60_000,
};

const DEFAULT_LIST_LIMIT = 1000;
const METADATA_HEADER_PREFIX = 'x-amz-meta-';

/**
 * Ceiling on any presigned GET TTL, default included: a leaked URL is an
 * unauthenticated grant on ciphertext, so its validity is capped at one hour
 * no matter what a caller asks for. Oversized requests are rejected
 * (fail fast), never silently clamped.
 */
export const MAX_PRESIGN_TTL_SECONDS = 3600;

function requireNonEmpty(value: string, field: string): void {
  if (value.length === 0) {
    throw new Error(`R2 storage config: ${field} is required`);
  }
}

function requirePositiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`R2 storage config: ${field} must be a positive integer`);
  }
}

/**
 * Encode the path portion of an S3 object URL. Keys contain segment
 * separators that must remain literal slashes — per-segment encoding
 * preserves the structure while escaping special characters within segments.
 */
function encodeObjectKey(key: string): string {
  return key
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

async function assertOk(response: Response, operation: string): Promise<void> {
  if (!response.ok) {
    let text: string;
    try {
      text = await response.text();
    } catch {
      text = '<unreadable body>';
    }
    throw new Error(`${operation} returned ${String(response.status)}: ${text}`);
  }
}

function statFromHeaders(key: string, headers: Headers): ObjectStat {
  const size = Number.parseInt(headers.get('content-length') ?? '', 10);
  if (!Number.isFinite(size)) {
    throw new TypeError('HEAD response has no numeric content-length');
  }
  const uploaded = new Date(headers.get('last-modified') ?? '');
  if (Number.isNaN(uploaded.getTime())) {
    throw new TypeError('HEAD response has no parseable last-modified');
  }
  const metadata: Record<string, string> = {};
  for (const [name, value] of headers) {
    if (name.startsWith(METADATA_HEADER_PREFIX)) {
      metadata[name.slice(METADATA_HEADER_PREFIX.length)] = value;
    }
  }
  return { key, size, uploaded, metadata };
}

export function createR2Storage(config: R2StorageConfig): Storage {
  requireNonEmpty(config.endpoint, 'endpoint');
  requireNonEmpty(config.bucket, 'bucket');
  requireNonEmpty(config.accessKeyId, 'accessKeyId');
  requireNonEmpty(config.secretAccessKey, 'secretAccessKey');
  requirePositiveInteger(config.maxObjectBytes, 'maxObjectBytes');
  requirePositiveInteger(config.defaultPresignTtlSeconds, 'defaultPresignTtlSeconds');

  const aws = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: 's3',
    region: 'auto',
    // aws4fetch defaults to 10 internal retries with backoff on 5xx/429 — a
    // second retry mechanism hidden inside every policy attempt. The policy
    // factory is the single retry seam; disable the built-in one.
    retries: 0,
  });
  const runner = retryWithTimeoutPolicy({ ...DEFAULT_NETWORK, ...config.network });
  const base = config.endpoint.replace(/\/+$/, '');

  const objectUrl = (key: string): string =>
    `${base}/${encodeURIComponent(config.bucket)}/${encodeObjectKey(key)}`;

  const listUrl = (prefix: string, options: ListOptions | undefined): string => {
    const params = new URLSearchParams({
      'list-type': '2',
      prefix,
      'max-keys': String(options?.limit ?? DEFAULT_LIST_LIMIT),
    });
    if (options?.cursor !== undefined) {
      params.set('continuation-token', options.cursor);
    }
    return `${base}/${encodeURIComponent(config.bucket)}?${params.toString()}`;
  };

  return {
    put(key: string, bytes: Uint8Array, options: PutOptions): ResultAsync<void, DomainError> {
      if (bytes.byteLength > config.maxObjectBytes) {
        return errAsync(validationError('media object exceeds the maximum size'));
      }
      const keyError = validateMediaKey(key) ?? validateStagingBinding(key, options.metadata);
      if (keyError !== null) {
        return errAsync(keyError);
      }
      const headers: Record<string, string> = { 'Content-Type': options.contentType };
      for (const [name, value] of Object.entries(options.metadata ?? {})) {
        headers[`${METADATA_HEADER_PREFIX}${name}`] = value;
      }
      // aws4fetch's BodyInit overload prefers a plain ArrayBuffer; the
      // caller's view may be partial or backed by a SharedArrayBuffer.
      // Uint8Array.from copies into a fresh, exactly-sized ArrayBuffer.
      const body = Uint8Array.from(bytes).buffer;
      return runner
        .run(async (signal) => {
          const response = await aws.fetch(objectUrl(key), {
            method: 'PUT',
            body,
            headers,
            signal,
          });
          await assertOk(response, 'PUT');
        })
        .andThen(() =>
          // Records only after the real PUT succeeds (a no-op outside CI), so
          // the evidence row proves a real S3 write, never a rejected one.
          fromPromise(
            recordServiceEvidence(config.db, config.isCI, SERVICE_NAMES.R2_STORAGE),
            (cause) => unavailableError('service-evidence write failed', cause)
          )
        );
    },

    presignGet(
      key: string,
      options?: { readonly expiresInSec?: number }
    ): ResultAsync<PresignedGet, DomainError> {
      const ttl = options?.expiresInSec ?? config.defaultPresignTtlSeconds;
      if (!Number.isInteger(ttl) || ttl <= 0) {
        return errAsync(validationError('presign expiry must be a positive integer of seconds'));
      }
      if (ttl > MAX_PRESIGN_TTL_SECONDS) {
        return errAsync(validationError('presign expiry exceeds the maximum TTL'));
      }
      return fromPromise(
        (async (): Promise<PresignedGet> => {
          const signed = await aws.sign(`${objectUrl(key)}?X-Amz-Expires=${String(ttl)}`, {
            method: 'GET',
            aws: { signQuery: true },
          });
          return { url: signed.url, expiresAt: new Date(Date.now() + ttl * 1000) };
        })(),
        (cause) => unavailableError('failed to mint presigned GET URL', cause)
      );
    },

    head(key: string): ResultAsync<ObjectStat | null, DomainError> {
      return runner.run(async (signal) => {
        const response = await aws.fetch(objectUrl(key), { method: 'HEAD', signal });
        if (response.status === 404) return null;
        await assertOk(response, 'HEAD');
        return statFromHeaders(key, response.headers);
      });
    },

    delete(key: string): ResultAsync<void, DomainError> {
      return runner.run(async (signal) => {
        // S3-compatible servers return 204 on success AND on missing keys
        // (idempotent delete); any non-OK response is a genuine error.
        const response = await aws.fetch(objectUrl(key), { method: 'DELETE', signal });
        await assertOk(response, 'DELETE');
      });
    },

    list(prefix: string, options?: ListOptions): ResultAsync<ListPage, DomainError> {
      return runner.run(async (signal) => {
        const response = await aws.fetch(listUrl(prefix, options), { method: 'GET', signal });
        await assertOk(response, 'LIST');
        return parseListObjectsV2Response(await response.text());
      });
    },
  };
}
