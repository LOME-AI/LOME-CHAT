import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Mode } from '@hushbox/shared';
import {
  parseTarget,
  selectE2eEnvMode,
  buildWebBundle,
  type BuildWebBundleDeps,
} from './build-web-bundle.js';

describe('build-web-bundle', () => {
  describe('parseTarget', () => {
    it('parses --target=e2e', () => {
      expect(parseTarget(['--target=e2e'])).toBe('e2e');
    });

    it('parses --target=prod', () => {
      expect(parseTarget(['--target=prod'])).toBe('prod');
    });

    it('throws when target is missing', () => {
      expect(() => parseTarget([])).toThrow(/--target/);
    });

    it('throws when target is invalid', () => {
      expect(() => parseTarget(['--target=dev'])).toThrow(/--target/);
    });
  });

  describe('selectE2eEnvMode', () => {
    // createEnvUtilities fail-fasts on a missing NODE_ENV, so every env
    // context here carries one explicitly — mirroring the real invocation,
    // which inherits NODE_ENV from with-env's loaded .dev.vars.
    it('maps to E2E when not in CI', () => {
      expect(selectE2eEnvMode({ NODE_ENV: 'development' })).toBe(Mode.E2E);
    });

    it('maps to CiE2E when in CI', () => {
      expect(selectE2eEnvMode({ NODE_ENV: 'development', CI: 'true' })).toBe(Mode.CiE2E);
    });
  });

  describe('buildWebBundle', () => {
    const makeDeps = () => ({
      generateEnv: vi.fn<BuildWebBundleDeps['generateEnv']>(),
      exec: vi.fn<BuildWebBundleDeps['exec']>(),
      merge: vi.fn<BuildWebBundleDeps['merge']>(),
      verify: vi.fn<BuildWebBundleDeps['verify']>(),
    });
    let deps: ReturnType<typeof makeDeps>;

    beforeEach(() => {
      deps = makeDeps();
    });

    it('regenerates frontend-only env for the selected mode before building (e2e local)', async () => {
      await buildWebBundle('e2e', '/repo', { NODE_ENV: 'development' }, deps);
      expect(deps.generateEnv).toHaveBeenCalledWith('/repo', Mode.E2E, { skipBackend: true });
    });

    it('builds web+marketing through turbo with --mode development for e2e', async () => {
      await buildWebBundle('e2e', '/repo', { NODE_ENV: 'development' }, deps);
      expect(deps.exec).toHaveBeenNthCalledWith(1, 'turbo', [
        'build',
        '--filter=@hushbox/web',
        '--filter=@hushbox/marketing',
        '--',
        '--mode',
        'development',
      ]);
    });

    it('does not generate env for prod and omits --mode development', async () => {
      await buildWebBundle('prod', '/repo', {}, deps);
      expect(deps.generateEnv).not.toHaveBeenCalled();
      expect(deps.exec).toHaveBeenNthCalledWith(1, 'turbo', [
        'build',
        '--filter=@hushbox/web',
        '--filter=@hushbox/marketing',
      ]);
    });

    it('generates headers without with-env for prod (caller-inline env)', async () => {
      await buildWebBundle('prod', '/repo', {}, deps);
      expect(deps.exec).toHaveBeenNthCalledWith(2, 'tsx', ['scripts/generate-headers.ts']);
    });

    it('merges marketing into web after the build', async () => {
      await buildWebBundle('e2e', '/repo', { NODE_ENV: 'development' }, deps);
      expect(deps.merge).toHaveBeenCalledWith({ repoRoot: '/repo' });
    });

    it('generates headers (under with-env) as the final step', async () => {
      await buildWebBundle('e2e', '/repo', { NODE_ENV: 'development' }, deps);
      expect(deps.exec).toHaveBeenNthCalledWith(2, 'tsx', [
        'scripts/with-env.ts',
        'tsx',
        'scripts/generate-headers.ts',
      ]);
    });

    it('verifies the merged web dist after merging', async () => {
      await buildWebBundle('e2e', '/repo', { NODE_ENV: 'development' }, deps);
      expect(deps.verify).toHaveBeenCalledWith({ distributionDir: '/repo/apps/web/dist' });
    });

    it('does not generate headers when verification fails', async () => {
      deps.verify.mockRejectedValueOnce(new Error('bundle verification failed'));
      await expect(buildWebBundle('prod', '/repo', {}, deps)).rejects.toThrow(
        'bundle verification failed'
      );
      expect(deps.exec).toHaveBeenCalledTimes(1);
    });

    it('does not merge or generate headers when the build fails', async () => {
      deps.exec.mockRejectedValueOnce(new Error('build failed'));
      await expect(
        buildWebBundle('e2e', '/repo', { NODE_ENV: 'development' }, deps)
      ).rejects.toThrow('build failed');
      expect(deps.merge).not.toHaveBeenCalled();
      expect(deps.exec).toHaveBeenCalledTimes(1);
    });
  });
});
