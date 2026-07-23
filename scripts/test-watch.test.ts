import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';

vi.mock('execa', () => ({ execa: vi.fn() }));

import { execa } from 'execa';
import { findOwningPackageDir, planInvocation, runVitest, type WatchFs } from './test-watch.js';

const mockExeca = vi.mocked(execa);

const ROOT = path.resolve('/repo');

/**
 * Fake fs: `files` are existing files, `packageDirs` contain a package.json,
 * `extraDirs` exist as directories without one. Package dirs also exist as
 * directories (as on a real disk).
 */
function fakeFs(
  files: readonly string[],
  packageDirectories: readonly string[],
  extraDirectories: readonly string[] = []
): WatchFs {
  const fileSet = new Set(files.map((f) => path.resolve(f)));
  const packageSet = new Set(packageDirectories.map((d) => path.resolve(d)));
  const dirSet = new Set([...packageSet, ...extraDirectories.map((d) => path.resolve(d))]);
  return {
    isFile: (p) => fileSet.has(path.resolve(p)),
    isDirectory: (p) => dirSet.has(path.resolve(p)),
    hasPackageJson: (dir) => packageSet.has(path.resolve(dir)),
  };
}

describe('findOwningPackageDir', () => {
  it('returns the nearest ancestor directory containing a package.json', () => {
    const fs = fakeFs([], [ROOT, path.join(ROOT, 'apps/web')]);
    const dir = findOwningPackageDir(path.join(ROOT, 'apps/web/src/foo.test.tsx'), ROOT, fs);
    expect(dir).toBe(path.join(ROOT, 'apps/web'));
  });

  it('returns the root when no intermediate package.json exists', () => {
    const fs = fakeFs([], [ROOT]);
    const dir = findOwningPackageDir(path.join(ROOT, 'e2e/foo.test.ts'), ROOT, fs);
    expect(dir).toBe(ROOT);
  });

  it('throws a clear error when no package.json exists up to the root', () => {
    const fs = fakeFs([], []);
    expect(() => findOwningPackageDir(path.join(ROOT, 'a/b.ts'), ROOT, fs)).toThrow(
      'test:watch: no package.json found'
    );
  });
});

describe('planInvocation', () => {
  it('keeps the invocation directory and empty args for watch-all usage', () => {
    const plan = planInvocation([], ROOT, fakeFs([], [ROOT]));
    expect(plan).toEqual({ cwd: ROOT, args: [] });
  });

  it('passes flags through unchanged without package detection', () => {
    const plan = planInvocation(['--ui'], ROOT, fakeFs([], [ROOT]));
    expect(plan).toEqual({ cwd: ROOT, args: ['--ui'] });
  });

  it('runs from the owning package directory for a single package file', () => {
    const file = path.join(ROOT, 'apps/web/src/foo.test.tsx');
    const fs = fakeFs([file], [ROOT, path.join(ROOT, 'apps/web')]);
    const plan = planInvocation(['apps/web/src/foo.test.tsx'], ROOT, fs);
    expect(plan).toEqual({ cwd: path.join(ROOT, 'apps/web'), args: [file] });
  });

  it('accepts multiple files from the same package', () => {
    const a = path.join(ROOT, 'apps/web/src/a.test.tsx');
    const b = path.join(ROOT, 'apps/web/src/b.test.ts');
    const fs = fakeFs([a, b], [ROOT, path.join(ROOT, 'apps/web')]);
    const plan = planInvocation(
      ['apps/web/src/a.test.tsx', 'apps/web/src/b.test.ts', '--run'],
      ROOT,
      fs
    );
    expect(plan).toEqual({ cwd: path.join(ROOT, 'apps/web'), args: [a, b, '--run'] });
  });

  it('detects the owning package for an existing directory argument', () => {
    const dir = path.join(ROOT, 'apps/api/src/slices/chat');
    const fs = fakeFs([], [ROOT, path.join(ROOT, 'apps/api')], [dir]);
    const plan = planInvocation(['apps/api/src/slices/chat'], ROOT, fs);
    expect(plan).toEqual({ cwd: path.join(ROOT, 'apps/api'), args: [dir] });
  });

  it('errors clearly when files span multiple packages', () => {
    const web = path.join(ROOT, 'apps/web/src/a.test.tsx');
    const api = path.join(ROOT, 'apps/api/src/b.test.ts');
    const fs = fakeFs([web, api], [ROOT, path.join(ROOT, 'apps/web'), path.join(ROOT, 'apps/api')]);
    expect(() =>
      planInvocation(['apps/web/src/a.test.tsx', 'apps/api/src/b.test.ts'], ROOT, fs)
    ).toThrow('test:watch: files span multiple packages');
  });

  it('stays in the invocation directory for a file owned by the root package', () => {
    const file = path.join(ROOT, 'e2e/foo.test.ts');
    const fs = fakeFs([file], [ROOT]);
    const plan = planInvocation(['e2e/foo.test.ts'], ROOT, fs);
    expect(plan).toEqual({ cwd: ROOT, args: [file] });
  });

  it('passes non-existent positional args through as vitest name filters', () => {
    const fs = fakeFs([], [ROOT, path.join(ROOT, 'apps/web')]);
    const plan = planInvocation(['thinking-disclosure'], ROOT, fs);
    expect(plan).toEqual({ cwd: ROOT, args: ['thinking-disclosure'] });
  });

  it('resolves relative file args against the invocation directory', () => {
    const base = path.join(ROOT, 'apps/web');
    const file = path.join(base, 'src/foo.test.tsx');
    const fs = fakeFs([file], [ROOT, base]);
    const plan = planInvocation(['src/foo.test.tsx'], base, fs);
    expect(plan).toEqual({ cwd: base, args: [file] });
  });
});

describe('runVitest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('spawns vitest in the planned directory, preferring its local binary', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0 } as never);
    const cwd = path.join(ROOT, 'apps/web');
    const exitCode = await runVitest({ cwd, args: ['--run', 'foo.test.ts'] });
    expect(mockExeca).toHaveBeenCalledWith('vitest', ['--run', 'foo.test.ts'], {
      stdio: 'inherit',
      reject: false,
      preferLocal: true,
      localDir: cwd,
      cwd,
    });
    expect(exitCode).toBe(0);
  });

  it('propagates a non-zero exit code from vitest', async () => {
    mockExeca.mockResolvedValue({ exitCode: 3 } as never);
    const exitCode = await runVitest({ cwd: ROOT, args: [] });
    expect(exitCode).toBe(3);
  });

  it('returns 1 when vitest exits with no numeric exit code', async () => {
    mockExeca.mockResolvedValue({ exitCode: undefined } as never);
    const exitCode = await runVitest({ cwd: ROOT, args: [] });
    expect(exitCode).toBe(1);
  });
});
