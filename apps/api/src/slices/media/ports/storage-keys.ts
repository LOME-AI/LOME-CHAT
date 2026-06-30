import { validationError } from '../../../lib/errors/index.js';
import type { DomainError } from '../../../lib/errors/index.js';

/**
 * The two storage key classes. All key segments are uuids —
 * content-addressing is deliberately dropped; a content-derived key would
 * store a durable fingerprint of plaintext. Builders throw on non-uuid
 * segments (a defect, not an expected failure).
 */

/** Epoch-wrapped final media objects: media/{conversationId}/{messageId}/{objectId}. */
export const MEDIA_PREFIX = 'media/';

/** Short-TTL client-encrypted large-input staging objects: inputs/{runId}/{objectId}. */
export const INPUTS_PREFIX = 'inputs/';

/**
 * Staging objects are GC-cron-enforced (not R2-lifecycle-enforced — lifecycle
 * granularity is days). The TTL must exceed the max flow deadline (~15 min
 * media) plus the GC margin so a live run's inputs are never reclaimed.
 */
export const INPUTS_STAGING_TTL_SECONDS = 3600;

/** S3 user-metadata key carrying the staging object's owning run id. */
export const STAGING_RUN_ID_METADATA_KEY = 'hb-run-id';

/** S3 user-metadata key carrying the staging object's own key (the ref). */
export const STAGING_REF_METADATA_KEY = 'hb-ref';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string, field: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new Error(`storage key segment "${field}" must be a uuid`);
  }
}

export interface MediaObjectLocation {
  readonly conversationId: string;
  readonly messageId: string;
  readonly objectId: string;
}

export interface StagingInputLocation {
  readonly runId: string;
  readonly objectId: string;
}

export function mediaObjectKey(location: MediaObjectLocation): string {
  assertUuid(location.conversationId, 'conversationId');
  assertUuid(location.messageId, 'messageId');
  assertUuid(location.objectId, 'objectId');
  return `${MEDIA_PREFIX}${location.conversationId}/${location.messageId}/${location.objectId}`;
}

export function stagingInputKey(location: StagingInputLocation): string {
  assertUuid(location.runId, 'runId');
  assertUuid(location.objectId, 'objectId');
  return `${INPUTS_PREFIX}${location.runId}/${location.objectId}`;
}

export function parseStagingInputKey(key: string): StagingInputLocation | null {
  if (!key.startsWith(INPUTS_PREFIX)) return null;
  const segments = key.slice(INPUTS_PREFIX.length).split('/');
  const [runId, objectId] = segments;
  if (segments.length !== 2 || runId === undefined || objectId === undefined) return null;
  if (!UUID_PATTERN.test(runId) || !UUID_PATTERN.test(objectId)) return null;
  return { runId, objectId };
}

/**
 * Run-binding metadata a staging object must carry. The client-side AEAD
 * binds the encrypted bytes to `(runId, ref)`; the object metadata records
 * the same binding server-side so GC and authz can verify it without
 * decrypting.
 */
export function stagingInputMetadata(location: StagingInputLocation): Record<string, string> {
  return {
    [STAGING_RUN_ID_METADATA_KEY]: location.runId,
    [STAGING_REF_METADATA_KEY]: stagingInputKey(location),
  };
}

/**
 * Write-time invariant for the media/ class (defense-in-depth parity with
 * the inputs/ binding check): every media object key matches
 * media/{conversationId}/{messageId}/{objectId} with uuid segments. Keys in
 * other classes carry no media constraint.
 */
export function validateMediaKey(key: string): DomainError | null {
  if (!key.startsWith(MEDIA_PREFIX)) return null;
  const segments = key.slice(MEDIA_PREFIX.length).split('/');
  if (segments.length !== 3 || !segments.every((segment) => UUID_PATTERN.test(segment))) {
    return validationError(
      'media/ key does not match media/{conversationId}/{messageId}/{objectId}'
    );
  }
  return null;
}

/**
 * Write-time invariant for the inputs/ class: every staging object carries
 * run-binding metadata that matches its own key. Non-staging keys have no
 * binding constraint.
 */
export function validateStagingBinding(
  key: string,
  metadata?: Readonly<Record<string, string>>
): DomainError | null {
  if (!key.startsWith(INPUTS_PREFIX)) return null;
  const location = parseStagingInputKey(key);
  if (location === null) {
    return validationError('inputs/ key does not match inputs/{runId}/{objectId}');
  }
  if (metadata?.[STAGING_RUN_ID_METADATA_KEY] !== location.runId) {
    return validationError('staging object metadata must bind the owning runId');
  }
  if (metadata[STAGING_REF_METADATA_KEY] !== key) {
    return validationError('staging object metadata must bind its own key as ref');
  }
  return null;
}
