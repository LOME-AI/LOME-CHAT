/**
 * Docker-backed deps for `ensureMediaBucketReady`, used by the `pnpm db:up`
 * bring-up path (scripts/db-bucket-ready.ts).
 *
 * `db:up` is a raw `docker compose up` — it does NOT go through
 * ensure-stack-cli, whose readiness gate is additionally a no-op in CI. So the
 * CI sequence `db:up → db:migrate → db:seed → e2e` had no gate at all: the old
 * `docker compose up -d minio-setup` was fire-and-forget, letting `db:seed`
 * issue a `storage.put` before `mc mb` created the bucket → `NoSuchBucket`.
 * Feeding these deps into the SAME `ensureMediaBucketReady` mechanism closes
 * that race on the db:up path without a second readiness implementation.
 *
 * The docker command is injected as a runner so the exit-code interpretation
 * (the only real logic here) is unit-testable without a live docker daemon.
 */
import { MEDIA_BUCKET } from './minio-bucket-ready.js';
import type { BucketReadyDeps } from './minio-bucket-ready.js';

export interface DockerCommandResult {
  readonly exitCode: number;
}

export type DockerRunner = (
  args: readonly string[],
  options: { readonly inheritStdio: boolean }
) => Promise<DockerCommandResult>;

export function createDockerBucketReadyDeps(run: DockerRunner): BucketReadyDeps {
  return {
    probeBucket: async () => {
      // Anonymous HEAD-bucket cannot distinguish existence (MinIO answers 403
      // either way), so probe storage truth directly: MinIO's single-drive
      // layout keeps each bucket as a top-level directory under /data.
      const result = await run(
        ['compose', 'exec', '-T', 'minio', 'sh', '-c', `test -d /data/${MEDIA_BUCKET}`],
        { inheritStdio: false }
      );
      return result.exitCode === 0;
    },
    runBucketSetup: async () => {
      // `run --rm` (unlike the old `up -d`) blocks until `mc mb -p` finishes.
      const result = await run(['compose', 'run', '--rm', 'minio-setup'], { inheritStdio: true });
      if (result.exitCode !== 0) {
        throw new Error(
          `db:up: "docker compose run --rm minio-setup" exited ${String(result.exitCode)} — ` +
            'media bucket setup failed. Check `docker compose logs minio-setup`.'
        );
      }
    },
  };
}
