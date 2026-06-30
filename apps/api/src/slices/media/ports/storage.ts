import type { ResultAsync } from '../../../lib/result/index.js';
import type { DomainError } from '../../../lib/errors/index.js';

/**
 * The Storage port (ARCHITECTURE.md infra edge). One implementation, one
 * codepath: the same S3 calls hit MinIO in dev/CI and Cloudflare R2 in
 * production. Holds ciphertext only; every key comes from the uuid key
 * builders in storage-keys.ts — never from content.
 *
 * There is intentionally no presigned PUT: all writes originate inside the
 * Worker (matches the verified legacy stance; reads bypass the Worker via
 * presigned GET so bytes flow R2 → client directly).
 */

export interface PutOptions {
  readonly contentType: string;
  /** S3 user metadata; required (run-binding) for inputs/ staging objects. */
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface PresignedGet {
  readonly url: string;
  readonly expiresAt: Date;
}

export interface ObjectStat {
  readonly key: string;
  readonly size: number;
  readonly uploaded: Date;
  /** S3 user metadata as stored (keys without the x-amz-meta- prefix). */
  readonly metadata: Readonly<Record<string, string>>;
}

export interface ListedObject {
  readonly key: string;
  readonly size: number;
  readonly uploaded: Date;
}

export interface ListPage {
  readonly objects: readonly ListedObject[];
  readonly nextCursor?: string;
}

export interface ListOptions {
  readonly cursor?: string;
  readonly limit?: number;
}

export interface Storage {
  /**
   * Store bytes at `key`. Idempotent: re-putting the same key/bytes yields
   * one object and no error (S3 PUT is last-write-wins).
   */
  put(key: string, bytes: Uint8Array, options: PutOptions): ResultAsync<void, DomainError>;

  /** Mint a short-lived presigned GET URL (default TTL: media download TTL). */
  presignGet(
    key: string,
    options?: { readonly expiresInSec?: number }
  ): ResultAsync<PresignedGet, DomainError>;

  /** Stat one object. Resolves null when the key does not exist. */
  head(key: string): ResultAsync<ObjectStat | null, DomainError>;

  /** Delete the object. Idempotent — succeeds when the key does not exist. */
  delete(key: string): ResultAsync<void, DomainError>;

  /** List objects under a prefix, paginated by cursor (GC primitive). */
  list(prefix: string, options?: ListOptions): ResultAsync<ListPage, DomainError>;
}
