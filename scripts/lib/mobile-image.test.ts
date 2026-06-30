import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

import { execa } from 'execa';
import {
  IMAGE_NAMESPACE,
  MOBILE_IMAGE_CONTEXT,
  computeImageHash,
  computeImageTag,
  localImageExists,
  manifestExists,
  bakeImage,
  runEmulatorContainer,
} from './mobile-image.js';

const mockExeca = vi.mocked(execa);

describe('mobile-image', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: '' } as never);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('IMAGE_NAMESPACE and MOBILE_IMAGE_CONTEXT', () => {
    it('exposes the GHCR namespace under lome-ai', () => {
      expect(IMAGE_NAMESPACE).toBe('ghcr.io/lome-ai/hushbox-android-emulator');
    });

    it('points to mobile-tests/docker for the build context', () => {
      // Absolute so docker build and hashing work regardless of caller cwd.
      expect(MOBILE_IMAGE_CONTEXT).toMatch(/[/\\]mobile-tests[/\\]docker$/);
      expect(path.isAbsolute(MOBILE_IMAGE_CONTEXT)).toBe(true);
    });
  });

  describe('computeImageHash', () => {
    let temporaryDir: string;

    beforeEach(async () => {
      temporaryDir = await mkdtemp(path.join(tmpdir(), 'mobile-image-hash-'));
    });

    afterEach(async () => {
      await rm(temporaryDir, { recursive: true, force: true });
    });

    it('returns a hex string', async () => {
      await writeFile(path.join(temporaryDir, 'Dockerfile'), 'FROM scratch\n');
      const hash = await computeImageHash(temporaryDir);
      expect(hash).toMatch(/^[0-9a-f]+$/);
    });

    it('produces the same hash for identical content', async () => {
      await writeFile(path.join(temporaryDir, 'Dockerfile'), 'FROM scratch\n');
      const first = await computeImageHash(temporaryDir);
      const second = await computeImageHash(temporaryDir);
      expect(first).toBe(second);
    });

    it('produces a different hash when file content changes', async () => {
      await writeFile(path.join(temporaryDir, 'Dockerfile'), 'FROM scratch\n');
      const before = await computeImageHash(temporaryDir);
      await writeFile(path.join(temporaryDir, 'Dockerfile'), 'FROM alpine\n');
      const after = await computeImageHash(temporaryDir);
      expect(after).not.toBe(before);
    });

    it('includes all files in the context dir, not just the Dockerfile', async () => {
      await writeFile(path.join(temporaryDir, 'Dockerfile'), 'FROM scratch\n');
      const before = await computeImageHash(temporaryDir);
      await writeFile(path.join(temporaryDir, 'extra.txt'), 'data');
      const after = await computeImageHash(temporaryDir);
      expect(after).not.toBe(before);
    });

    it('hashes files recursively', async () => {
      await writeFile(path.join(temporaryDir, 'Dockerfile'), 'FROM scratch\n');
      const before = await computeImageHash(temporaryDir);
      await mkdir(path.join(temporaryDir, 'sub'));
      await writeFile(path.join(temporaryDir, 'sub', 'nested'), 'x');
      const after = await computeImageHash(temporaryDir);
      expect(after).not.toBe(before);
    });

    it('is order-independent with respect to filesystem listing', async () => {
      // Hash should depend on (path, content) pairs sorted consistently, not on
      // the OS's readdir order. We can't easily simulate alternate orderings,
      // but we can confirm that adding files in different orders yields the
      // same final hash.
      await writeFile(path.join(temporaryDir, 'a'), '1');
      await writeFile(path.join(temporaryDir, 'b'), '2');
      const first = await computeImageHash(temporaryDir);
      await rm(path.join(temporaryDir, 'a'));
      await rm(path.join(temporaryDir, 'b'));
      await writeFile(path.join(temporaryDir, 'b'), '2');
      await writeFile(path.join(temporaryDir, 'a'), '1');
      const second = await computeImageHash(temporaryDir);
      expect(first).toBe(second);
    });

    it('ignores entries that are neither files nor directories', async () => {
      await writeFile(path.join(temporaryDir, 'Dockerfile'), 'FROM scratch\n');
      const before = await computeImageHash(temporaryDir);
      await symlink(path.join(temporaryDir, 'Dockerfile'), path.join(temporaryDir, 'link'));
      const after = await computeImageHash(temporaryDir);
      expect(after).toBe(before);
    });
  });

  describe('runEmulatorContainer', () => {
    const baseOptions = {
      name: 'hushbox-mobile-emulator-shard-0',
      hostAdbPort: 5555,
      imageTag: 'ghcr.io/lome-ai/hushbox-android-emulator:tag',
      kvmGid: '993',
    };

    it('enables the noVNC viewer only when includeVnc is set', async () => {
      await runEmulatorContainer({ ...baseOptions, includeVnc: true });

      const run = mockExeca.mock.calls.find(
        ([, args]) => Array.isArray(args) && args.includes('run')
      );
      expect(run?.[1]).toContain('WEB_VNC=true');
    });

    it('omits the noVNC env var when includeVnc is false', async () => {
      await runEmulatorContainer({ ...baseOptions, includeVnc: false });

      const run = mockExeca.mock.calls.find(
        ([, args]) => Array.isArray(args) && args.includes('run')
      );
      expect(run).toBeDefined();
      expect(run?.[1]).not.toContain('WEB_VNC=true');
    });

    it('still starts the emulator when the leftover-container removal fails', async () => {
      mockExeca.mockImplementation(((cmd: string, args?: readonly string[]) => {
        if (cmd === 'docker' && Array.isArray(args) && args[0] === 'rm') {
          return Promise.reject(new Error('no such container'));
        }
        return Promise.resolve({ exitCode: 0, stdout: '' });
      }) as never);

      await runEmulatorContainer({ ...baseOptions, includeVnc: false });

      const run = mockExeca.mock.calls.find(
        ([, args]) => Array.isArray(args) && args.includes('run')
      );
      expect(run).toBeDefined();
    });
  });

  describe('computeImageTag', () => {
    it('returns a tag in the IMAGE_NAMESPACE with a hex hash', async () => {
      const tag = await computeImageTag();
      expect(tag).toMatch(new RegExp(`^${IMAGE_NAMESPACE}:[0-9a-f]+$`));
    });

    it('is deterministic across calls', async () => {
      const a = await computeImageTag();
      const b = await computeImageTag();
      expect(a).toBe(b);
    });
  });

  describe('localImageExists', () => {
    it('returns true when docker images outputs a non-empty id', async () => {
      mockExeca.mockResolvedValueOnce({ stdout: 'sha256:abc123', exitCode: 0 } as never);
      expect(await localImageExists('test:tag')).toBe(true);
      expect(mockExeca).toHaveBeenCalledWith('docker', ['images', '-q', 'test:tag']);
    });

    it('returns false when docker images outputs an empty string', async () => {
      mockExeca.mockResolvedValueOnce({ stdout: '', exitCode: 0 } as never);
      expect(await localImageExists('test:tag')).toBe(false);
    });

    it('returns false when docker images outputs only whitespace', async () => {
      mockExeca.mockResolvedValueOnce({ stdout: '\n  \n', exitCode: 0 } as never);
      expect(await localImageExists('test:tag')).toBe(false);
    });

    it('returns false when docker images throws (daemon offline, etc)', async () => {
      mockExeca.mockRejectedValueOnce(new Error('daemon not running'));
      expect(await localImageExists('test:tag')).toBe(false);
    });
  });

  describe('manifestExists', () => {
    it('returns true when docker manifest inspect exits 0', async () => {
      mockExeca.mockResolvedValueOnce({ exitCode: 0 } as never);
      expect(await manifestExists('test:tag')).toBe(true);
      expect(mockExeca).toHaveBeenCalledWith(
        'docker',
        ['manifest', 'inspect', 'test:tag'],
        expect.objectContaining({ stdio: 'ignore' })
      );
    });

    it('returns false when docker manifest inspect rejects', async () => {
      mockExeca.mockRejectedValueOnce(new Error('manifest unknown'));
      expect(await manifestExists('test:tag')).toBe(false);
    });
  });

  describe('bakeImage', () => {
    function dockerImagesResponse(options: { localHit?: boolean }): Promise<unknown> {
      return Promise.resolve({ stdout: options.localHit ? 'sha256:cached' : '' });
    }

    function manifestResponse(options: { remoteHit?: boolean }): Promise<unknown> {
      return options.remoteHit
        ? Promise.resolve({ exitCode: 0 })
        : Promise.reject(new Error('manifest unknown'));
    }

    function dispatchBakeCall(
      cmd: string,
      args: readonly string[],
      options: { localHit?: boolean; remoteHit?: boolean }
    ): Promise<unknown> {
      if (cmd === 'docker' && args[0] === 'images' && args[1] === '-q') {
        return dockerImagesResponse(options);
      }
      if (cmd === 'docker' && args[0] === 'manifest' && args[1] === 'inspect') {
        return manifestResponse(options);
      }
      return Promise.resolve({ exitCode: 0, stdout: '' });
    }

    function setupBakePath(options: { localHit?: boolean; remoteHit?: boolean }): void {
      mockExeca.mockImplementation(((cmd: string, args?: readonly string[]) =>
        dispatchBakeCall(cmd, Array.isArray(args) ? args : [], options)) as never);
    }

    it('returns the tag and skips work when the image is in the local cache', async () => {
      setupBakePath({ localHit: true });

      const tag = await bakeImage({ push: false });

      expect(tag).toMatch(new RegExp(`^${IMAGE_NAMESPACE}:[0-9a-f]+$`));
      const calls = mockExeca.mock.calls.map(
        (c) => `${String(c[0])} ${(c[1] as string[]).join(' ')}`
      );
      expect(calls.some((c) => c.includes('build'))).toBe(false);
      expect(calls.some((c) => c.includes('commit'))).toBe(false);
      expect(calls.some((c) => c.includes('push'))).toBe(false);
      expect(calls.some((c) => c.startsWith('docker pull'))).toBe(false);
    });

    it('pulls from the registry on local miss but manifest hit', async () => {
      setupBakePath({ localHit: false, remoteHit: true });

      const tag = await bakeImage({ push: false });

      expect(mockExeca).toHaveBeenCalledWith(
        'docker',
        ['pull', tag],
        expect.objectContaining({ stdio: 'inherit' })
      );
      const calls = mockExeca.mock.calls.map(
        (c) => `${String(c[0])} ${(c[1] as string[]).join(' ')}`
      );
      expect(calls.some((c) => c.includes('build'))).toBe(false);
    });

    it('builds the content-hashed image (cold-boot, no snapshot) when local and remote miss', async () => {
      setupBakePath({ localHit: false, remoteHit: false });

      const tag = await bakeImage({ push: false });

      expect(mockExeca).toHaveBeenCalledWith(
        'docker',
        expect.arrayContaining(['build', '-t', tag, MOBILE_IMAGE_CONTEXT]),
        expect.anything()
      );
      // Cold-boot model: the bake builds the image only — no emulator run,
      // snapshot save, or commit (those produced an unbootable committed image).
      const calls = mockExeca.mock.calls.map(
        (c) => `${String(c[0])} ${(c[1] as string[]).join(' ')}`
      );
      expect(calls.some((c) => c.includes('run -d') || c.includes('--privileged'))).toBe(false);
      expect(calls.some((c) => c.includes('snapshot'))).toBe(false);
      expect(calls.some((c) => c.includes('commit'))).toBe(false);
    });

    it('pushes when push=true', async () => {
      setupBakePath({ localHit: false, remoteHit: false });

      const tag = await bakeImage({ push: true });

      expect(mockExeca).toHaveBeenCalledWith(
        'docker',
        ['push', tag],
        expect.objectContaining({ stdio: 'inherit' })
      );
    });

    it('does not push when push=false', async () => {
      setupBakePath({ localHit: false, remoteHit: false });

      await bakeImage({ push: false });

      const calls = mockExeca.mock.calls.map(
        (c) => `${String(c[0])} ${(c[1] as string[]).join(' ')}`
      );
      expect(calls.some((c) => c.startsWith('docker push'))).toBe(false);
    });

    it('does not push on cache hit even when push=true (already in registry)', async () => {
      setupBakePath({ localHit: false, remoteHit: true });

      await bakeImage({ push: true });

      const calls = mockExeca.mock.calls.map(
        (c) => `${String(c[0])} ${(c[1] as string[]).join(' ')}`
      );
      expect(calls.some((c) => c.startsWith('docker push'))).toBe(false);
    });

    it('does not run/commit a container during the build (cold-boot model)', async () => {
      setupBakePath({ localHit: false, remoteHit: false });

      await bakeImage({ push: false });

      const ranContainer = mockExeca.mock.calls.some(
        (c) => c[0] === 'docker' && Array.isArray(c[1]) && (c[1] as string[])[0] === 'run'
      );
      const committed = mockExeca.mock.calls.some(
        (c) => c[0] === 'docker' && Array.isArray(c[1]) && (c[1] as string[])[0] === 'commit'
      );
      expect(ranContainer).toBe(false);
      expect(committed).toBe(false);
    });
  });
});
