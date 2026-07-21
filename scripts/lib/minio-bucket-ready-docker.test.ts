import { describe, it, expect, vi } from 'vitest';
import { createDockerBucketReadyDeps, type DockerRunner } from './minio-bucket-ready-docker.js';
import { MEDIA_BUCKET } from './minio-bucket-ready.js';

describe('createDockerBucketReadyDeps', () => {
  it('probeBucket reports the bucket present when the probe command exits 0', async () => {
    const run: DockerRunner = vi.fn(() => Promise.resolve({ exitCode: 0 }));
    const deps = createDockerBucketReadyDeps(run);

    await expect(deps.probeBucket()).resolves.toBe(true);
  });

  it('probeBucket reports the bucket absent when the probe command exits non-zero', async () => {
    const run: DockerRunner = vi.fn(() => Promise.resolve({ exitCode: 1 }));
    const deps = createDockerBucketReadyDeps(run);

    await expect(deps.probeBucket()).resolves.toBe(false);
  });

  it('probeBucket checks the media bucket directory on the minio container without inheriting stdio', async () => {
    const run = vi.fn<DockerRunner>(() => Promise.resolve({ exitCode: 0 }));
    const deps = createDockerBucketReadyDeps(run);

    await deps.probeBucket();

    expect(run).toHaveBeenCalledTimes(1);
    const [args, options] = run.mock.calls[0]!;
    expect(args).toEqual([
      'compose',
      'exec',
      '-T',
      'minio',
      'sh',
      '-c',
      `test -d /data/${MEDIA_BUCKET}`,
    ]);
    expect(options.inheritStdio).toBe(false);
  });

  it('runBucketSetup runs the minio-setup service to completion with inherited stdio', async () => {
    const run = vi.fn<DockerRunner>(() => Promise.resolve({ exitCode: 0 }));
    const deps = createDockerBucketReadyDeps(run);

    await deps.runBucketSetup();

    expect(run).toHaveBeenCalledTimes(1);
    const [args, options] = run.mock.calls[0]!;
    expect(args).toEqual(['compose', 'run', '--rm', 'minio-setup']);
    expect(options.inheritStdio).toBe(true);
  });

  it('runBucketSetup fails loud when the setup command exits non-zero', async () => {
    const run: DockerRunner = vi.fn(() => Promise.resolve({ exitCode: 2 }));
    const deps = createDockerBucketReadyDeps(run);

    await expect(deps.runBucketSetup()).rejects.toThrow('minio-setup');
  });
});
