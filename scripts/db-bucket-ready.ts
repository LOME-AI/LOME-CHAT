/**
 * `pnpm db:up` storage-readiness gate. After the compose services are up,
 * block until the media bucket actually exists (creating it via minio-setup if
 * missing) before any consumer — notably `pnpm db:seed` in CI — issues a
 * `storage.put`. Reuses the single readiness mechanism (`ensureMediaBucketReady`);
 * this file is only real-IO wiring, mirroring ensure-stack-cli.ts.
 */
import { pathToFileURL } from 'node:url';
import { execa } from 'execa';
import { isMainModule } from './lib/is-main.js';
import { runMain } from './lib/run-main.js';
import { ensureMediaBucketReady } from './lib/minio-bucket-ready.js';
import { createDockerBucketReadyDeps } from './lib/minio-bucket-ready-docker.js';

/* v8 ignore start -- real-IO wiring; logic lives in tested pure helpers */
async function main(): Promise<void> {
  const deps = createDockerBucketReadyDeps(async (args, options) => {
    const result = await execa('docker', [...args], {
      cwd: process.cwd(),
      stdio: options.inheritStdio ? 'inherit' : 'pipe',
      env: process.env,
      reject: false,
    });
    return { exitCode: result.exitCode ?? 1 };
  });
  await ensureMediaBucketReady(deps);
}

if (
  isMainModule(import.meta.url) ||
  pathToFileURL(process.argv[1] ?? '').href === import.meta.url
) {
  await runMain(main);
}
/* v8 ignore stop */
