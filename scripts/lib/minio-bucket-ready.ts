/**
 * MinIO media-bucket readiness gate.
 *
 * Container health is not storage readiness: `minio` can be healthy while the
 * media bucket does not exist yet (cold volume before `minio-setup` lands, a
 * crash between MinIO start and setup, or a wiped volume under warm
 * containers). Serving the API before the bucket exists turns every media
 * `storage.put` into `NoSuchBucket` → UNAVAILABLE, so stack bring-up must
 * block on the bucket actually existing — never on `minio-setup` merely
 * having been started.
 *
 * Pure orchestration; the docker probes/runners are injected by the CLI
 * wiring (ensure-stack-cli.ts).
 */

/** Must match the bucket `minio-setup` creates in docker-compose.yml. */
export const MEDIA_BUCKET = 'hushbox-media-dev';

export interface BucketReadyDeps {
  /** True iff the media bucket exists on the running MinIO instance. */
  probeBucket: () => Promise<boolean>;
  /** Run bucket creation to completion; must reject on failure. */
  runBucketSetup: () => Promise<void>;
}

export async function ensureMediaBucketReady(deps: BucketReadyDeps): Promise<void> {
  if (await deps.probeBucket()) return;
  await deps.runBucketSetup();
  if (await deps.probeBucket()) return;
  throw new Error(
    `ensure-stack: MinIO bucket "${MEDIA_BUCKET}" is still missing after minio-setup ran — ` +
      'storage is not ready. Check `docker compose logs minio-setup`.'
  );
}
