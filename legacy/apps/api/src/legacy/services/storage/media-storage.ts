import { AwsClient } from 'aws4fetch';
import { MAX_MEDIA_OBJECT_BYTES, MEDIA_DOWNLOAD_URL_TTL_SECONDS } from '@hushbox/shared';
import { recordServiceEvidence, SERVICE_NAMES, type EvidenceConfig } from '@hushbox/db';
import { StorageReadError, StorageWriteError, type MediaStorage } from './types.js';

/**
 * Single-PUT only. Multipart upload is not implemented; payloads exceeding
 * MAX_MEDIA_OBJECT_BYTES are rejected at write time.
 */

/**
 * Subset of env vars the storage layer needs. All five are required at
 * construction time — fail-fast with a clear error if any is missing.
 *
 * Same code path branches only on env config: MinIO endpoint+creds in
 * dev/CI, R2 S3 endpoint+access keys in production. No Workers binding.
 *
 * Optional `evidence` mirrors the AIClient/Helcim pattern: when supplied,
 * each successful storage operation records `SERVICE_NAMES.R2_STORAGE`
 * evidence so CI's verify:evidence step can prove the integration was
 * exercised. `recordServiceEvidence` itself gates writes on `isCI === true`,
 * so production ignores the row even when the config is present.
 */
export interface MediaStorageEnv {
  R2_S3_ENDPOINT?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_BUCKET_MEDIA?: string;
  evidence?: EvidenceConfig;
}

interface ValidatedConfig {
  endpoint: string;
  bucketName: string;
  accessKeyId: string;
  secretAccessKey: string;
}

function requireConfig(env: MediaStorageEnv): ValidatedConfig {
  if (env.R2_S3_ENDPOINT === undefined || env.R2_S3_ENDPOINT.length === 0) {
    throw new Error('R2_S3_ENDPOINT is required for media storage');
  }
  if (env.R2_ACCESS_KEY_ID === undefined || env.R2_ACCESS_KEY_ID.length === 0) {
    throw new Error('R2_ACCESS_KEY_ID is required for media storage');
  }
  if (env.R2_SECRET_ACCESS_KEY === undefined || env.R2_SECRET_ACCESS_KEY.length === 0) {
    throw new Error('R2_SECRET_ACCESS_KEY is required for media storage');
  }
  if (env.R2_BUCKET_MEDIA === undefined || env.R2_BUCKET_MEDIA.length === 0) {
    throw new Error('R2_BUCKET_MEDIA is required for media storage');
  }
  return {
    endpoint: env.R2_S3_ENDPOINT,
    bucketName: env.R2_BUCKET_MEDIA,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  };
}

/**
 * Encode the path portion of an S3 object URL. The bucket name has no `/`
 * (S3 forbids them) so a single `encodeURIComponent` is fine. The key may
 * contain segment separators that must remain literal slashes — encoding
 * them as `%2F` is the most pessimistic form and unnecessary on R2/MinIO.
 * Per-segment encoding preserves the segment structure while still escaping
 * special characters within each segment.
 */
function encodeObjectKey(key: string): string {
  return key
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function buildObjectUrl(endpoint: string, bucket: string, key: string): string {
  const base = endpoint.replace(/\/+$/, '');
  return `${base}/${encodeURIComponent(bucket)}/${encodeObjectKey(key)}`;
}

function buildPresignUrl(endpoint: string, bucket: string, key: string, ttlSec: number): string {
  return `${buildObjectUrl(endpoint, bucket, key)}?X-Amz-Expires=${String(ttlSec)}`;
}

interface ListUrlParams {
  endpoint: string;
  bucket: string;
  prefix: string;
  cursor: string | undefined;
  limit: number;
}

function buildListUrl(input: ListUrlParams): string {
  const base = input.endpoint.replace(/\/+$/, '');
  const params = new URLSearchParams({
    'list-type': '2',
    prefix: input.prefix,
    'max-keys': String(input.limit),
  });
  if (input.cursor !== undefined) {
    params.set('continuation-token', input.cursor);
  }
  return `${base}/${encodeURIComponent(input.bucket)}?${params.toString()}`;
}

const DEFAULT_LIST_LIMIT = 1000;

export function createMediaStorage(env: MediaStorageEnv): MediaStorage {
  const config = requireConfig(env);
  const evidence = env.evidence;

  const aws = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: 's3',
    region: 'auto',
  });

  const recordEvidence = async (): Promise<void> => {
    if (evidence === undefined) return;
    await recordServiceEvidence(evidence.db, evidence.isCI, SERVICE_NAMES.R2_STORAGE);
  };

  return {
    async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
      if (bytes.byteLength > MAX_MEDIA_OBJECT_BYTES) {
        throw new StorageWriteError(
          `Media object exceeds maximum size of ${String(MAX_MEDIA_OBJECT_BYTES)} bytes (got ${String(bytes.byteLength)})`
        );
      }
      const url = buildObjectUrl(config.endpoint, config.bucketName, key);
      try {
        // aws4fetch's BodyInit overload prefers `ArrayBuffer`. The caller's
        // `bytes.buffer` is typed `ArrayBufferLike` (which includes
        // `SharedArrayBuffer`) and may be a partial view. `Uint8Array.from`
        // copies the bytes into a fresh, plain `ArrayBuffer` of exactly
        // `bytes.length` size — usable directly without further casting.
        const arrayBuffer = Uint8Array.from(bytes).buffer;
        const response = await aws.fetch(url, {
          method: 'PUT',
          body: arrayBuffer,
          headers: { 'Content-Type': contentType },
        });
        if (!response.ok) {
          const text = await safeReadText(response);
          throw new Error(`PUT ${key} returned ${String(response.status)}: ${text}`);
        }
      } catch (error) {
        throw new StorageWriteError(`Failed to write ${key}`, { cause: error });
      }
      await recordEvidence();
    },

    async delete(key: string): Promise<void> {
      const url = buildObjectUrl(config.endpoint, config.bucketName, key);
      try {
        const response = await aws.fetch(url, { method: 'DELETE' });
        // S3-compatible servers (R2, MinIO) return 204 No Content on success
        // and on missing keys (idempotent delete) — they never return 404 here,
        // so any non-OK response is a genuine error.
        if (!response.ok) {
          const text = await safeReadText(response);
          throw new Error(`DELETE ${key} returned ${String(response.status)}: ${text}`);
        }
      } catch (error) {
        throw new StorageWriteError(`Failed to delete ${key}`, { cause: error });
      }
      await recordEvidence();
    },

    async mintDownloadUrl(params: {
      key: string;
      expiresInSec?: number;
    }): Promise<{ url: string; expiresAt: string }> {
      const ttl = params.expiresInSec ?? MEDIA_DOWNLOAD_URL_TTL_SECONDS;
      const url = buildPresignUrl(config.endpoint, config.bucketName, params.key, ttl);
      try {
        const signed = await aws.sign(url, { method: 'GET', aws: { signQuery: true } });
        const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
        await recordEvidence();
        return { url: signed.url, expiresAt };
      } catch (error) {
        throw new StorageReadError(`Failed to mint download URL for ${params.key}`, {
          cause: error,
        });
      }
    },

    async list(
      prefix: string,
      options?: { cursor?: string; limit?: number }
    ): Promise<{
      objects: { key: string; uploaded: Date; size: number }[];
      nextCursor?: string;
    }> {
      const limit = options?.limit ?? DEFAULT_LIST_LIMIT;
      const url = buildListUrl({
        endpoint: config.endpoint,
        bucket: config.bucketName,
        prefix,
        cursor: options?.cursor,
        limit,
      });
      try {
        const response = await aws.fetch(url, { method: 'GET' });
        if (!response.ok) {
          const text = await safeReadText(response);
          throw new Error(`LIST ${prefix} returned ${String(response.status)}: ${text}`);
        }
        const xml = await response.text();
        const result = parseListObjectsV2Response(xml);
        await recordEvidence();
        return result;
      } catch (error) {
        throw new StorageReadError(`Failed to list under prefix ${prefix}`, { cause: error });
      }
    },
  };
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '<unreadable body>';
  }
}

const XML_ENTITY_MAP: Readonly<Record<string, string>> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
};

function decodeXmlEntities(value: string): string {
  return value.replaceAll(/&(?:amp|lt|gt|quot|apos);/g, (m) => XML_ENTITY_MAP[m] ?? m);
}

const NS_PREFIX = String.raw`(?:[a-zA-Z][\w.-]*:)?`;

/**
 * Hand-rolled S3 ListObjectsV2 XML parser. The response shape is well-defined
 * and stable; we only extract `<Contents>` blocks (key, lastModified, size)
 * plus `<IsTruncated>` and `<NextContinuationToken>`. No XML parser dependency.
 *
 * Tag matching tolerates an optional XML namespace prefix (e.g. `s3:Contents`)
 * and self-closing tags (e.g. `<IsTruncated/>` parses as empty string).
 *
 * Tag content is XML-entity-decoded for the five named entities S3 emits
 * (`&amp;`, `&lt;`, `&gt;`, `&quot;`, `&apos;`). Numeric character references
 * (`&#NN;`, `&#xHH;`) are not used by S3 ListObjectsV2 and intentionally not
 * handled — chose the minimal correct decoder rather than pulling in a parser
 * dependency. Without this, a key like `foo&bar` arrives as the literal string
 * `foo&amp;bar` and the GC orphan check (which compares against DB-stored,
 * already-decoded keys) would fail to match — and delete a live object.
 */
function parseListObjectsV2Response(xml: string): {
  objects: { key: string; uploaded: Date; size: number }[];
  nextCursor?: string;
} {
  const objects: { key: string; uploaded: Date; size: number }[] = [];
  const contentsRegex = new RegExp(
    String.raw`<${NS_PREFIX}Contents>([\s\S]*?)</${NS_PREFIX}Contents>`,
    'g'
  );
  let match: RegExpExecArray | null = contentsRegex.exec(xml);
  while (match !== null) {
    const block = match[1] ?? '';
    const key = extractTag(block, 'Key');
    const lastModified = extractTag(block, 'LastModified');
    const sizeRaw = extractTag(block, 'Size');
    if (key !== undefined && lastModified !== undefined && sizeRaw !== undefined) {
      const size = Number.parseInt(sizeRaw, 10);
      if (Number.isFinite(size)) {
        objects.push({
          key,
          uploaded: new Date(lastModified),
          size,
        });
      } else {
        console.warn('parseListObjectsV2Response: skipping non-numeric Size', { key, sizeRaw });
      }
    }
    match = contentsRegex.exec(xml);
  }
  const truncated = extractTag(xml, 'IsTruncated') === 'true';
  const nextContinuationToken = truncated ? extractTag(xml, 'NextContinuationToken') : undefined;
  return {
    objects,
    ...(nextContinuationToken !== undefined && { nextCursor: nextContinuationToken }),
  };
}

/**
 * Extract the text body of an XML tag. Tolerates an optional namespace prefix
 * (`<s3:Tag>...</s3:Tag>`) and self-closing tags (`<Tag/>` returns empty
 * string). The returned value has XML entities decoded.
 */
function extractTag(xml: string, tag: string): string | undefined {
  const selfClosing = new RegExp(String.raw`<${NS_PREFIX}${tag}\s*/>`);
  if (selfClosing.test(xml)) {
    return '';
  }
  const regex = new RegExp(
    String.raw`<${NS_PREFIX}${tag}(?:\s[^>]*)?>([^<]*)</${NS_PREFIX}${tag}>`
  );
  const raw = regex.exec(xml)?.[1];
  return raw === undefined ? undefined : decodeXmlEntities(raw);
}
