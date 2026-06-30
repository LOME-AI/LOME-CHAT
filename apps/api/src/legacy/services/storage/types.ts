/**
 * Object storage abstraction for encrypted media.
 *
 * One implementation, one codepath: the same `aws4fetch` S3 calls hit MinIO
 * in dev/CI and Cloudflare R2 in production. Endpoint URL and credentials
 * are the only environment-specific config.
 *
 * Reads are done by clients via short-lived presigned GET URLs minted via
 * the S3 API — bytes flow direct R2 → browser without passing through the
 * Worker.
 *
 * There is intentionally NO mintUploadUrl. Presigned PUT URLs are a security
 * anti-pattern; all writes originate inside the Worker.
 */
export interface MediaStorage {
  /**
   * Store encrypted bytes at the given key.
   * Called from strategies after encrypting media under a message's content key.
   * @throws StorageWriteError on upstream failure.
   */
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;

  /**
   * Mint a short-lived presigned GET URL for reading the object at `key`.
   * The URL is signed with the R2 S3 credentials and expires after the
   * configured TTL (default MEDIA_DOWNLOAD_URL_TTL_SECONDS).
   *
   * `expiresAt` is an ISO-8601 timestamp — the client uses it to decide
   * when to re-mint before the URL expires.
   *
   * @throws StorageReadError on signing/backing-store failure.
   */
  mintDownloadUrl(params: {
    key: string;
    expiresInSec?: number;
  }): Promise<{ url: string; expiresAt: string }>;

  /**
   * Delete the object at `key`. Idempotent — succeeds if the key doesn't exist.
   * @throws StorageWriteError on upstream failure.
   */
  delete(key: string): Promise<void>;

  /**
   * List objects under a prefix, paginated by cursor. Used by the daily R2 GC
   * cron to find orphans. Wraps S3 ListObjectsV2.
   *
   * @throws StorageReadError on listing failure.
   */
  list(
    prefix: string,
    options?: { cursor?: string; limit?: number }
  ): Promise<{
    objects: { key: string; uploaded: Date; size: number }[];
    nextCursor?: string;
  }>;
}

/**
 * Thrown when a storage write (`put` or `delete`) fails upstream.
 * The cause is the underlying error from the S3 backend, preserved for logging.
 */
export class StorageWriteError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'StorageWriteError';
  }
}

/**
 * Thrown when a presigned URL cannot be minted, a list call fails, or any
 * other read fails.
 */
export class StorageReadError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'StorageReadError';
  }
}
