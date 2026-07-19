import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Mode } from '@hushbox/shared';
import { buildAdminBundle, type BuildAdminBundleDeps } from './build-admin-bundle.js';

describe('build-admin-bundle', () => {
  const makeDeps = () => ({
    generateEnv: vi.fn<BuildAdminBundleDeps['generateEnv']>(),
    exec: vi.fn<BuildAdminBundleDeps['exec']>(),
  });
  let deps: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    deps = makeDeps();
  });

  // createEnvUtilities fail-fasts on a missing NODE_ENV, so every env context
  // here carries one explicitly — mirroring the real invocation, which inherits
  // NODE_ENV from with-env's loaded .dev.vars.
  it('regenerates frontend-only env for the E2E mode before building (local)', async () => {
    await buildAdminBundle('/repo', { NODE_ENV: 'development' }, deps);
    expect(deps.generateEnv).toHaveBeenCalledWith('/repo', Mode.E2E, { skipBackend: true });
  });

  it('regenerates env for CiE2E mode when in CI', async () => {
    await buildAdminBundle('/repo', { NODE_ENV: 'development', CI: 'true' }, deps);
    expect(deps.generateEnv).toHaveBeenCalledWith('/repo', Mode.CiE2E, { skipBackend: true });
  });

  it('builds admin through turbo with --mode development', async () => {
    await buildAdminBundle('/repo', { NODE_ENV: 'development' }, deps);
    expect(deps.exec).toHaveBeenCalledWith('turbo', [
      'build',
      '--filter=@hushbox/admin',
      '--',
      '--mode',
      'development',
    ]);
  });

  it('runs only the turbo build — no marketing merge (admin CSP `_headers` come from its own Vite build)', async () => {
    await buildAdminBundle('/repo', { NODE_ENV: 'development' }, deps);
    expect(deps.exec).toHaveBeenCalledTimes(1);
  });

  it('generates env before invoking the build', async () => {
    const order: string[] = [];
    deps.generateEnv.mockImplementation(() => {
      order.push('generateEnv');
    });
    deps.exec.mockImplementation(() => {
      order.push('exec');
      return Promise.resolve();
    });
    await buildAdminBundle('/repo', { NODE_ENV: 'development' }, deps);
    expect(order).toEqual(['generateEnv', 'exec']);
  });
});
