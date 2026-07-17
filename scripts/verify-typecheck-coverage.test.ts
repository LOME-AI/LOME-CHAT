import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('./workspaces.js', () => ({
  discoverWorkspaces: vi.fn(),
}));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DIR = path.join(__dirname, '__test-fixtures-typecheck__');

describe('verify-typecheck-coverage', () => {
  beforeEach(async () => {
    await mkdir(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  describe('findOrphanedFiles', () => {
    it('returns files present in source but not in covered set', async () => {
      const { findOrphanedFiles } = await import('./verify-typecheck-coverage.js');

      const allSourceFiles = new Set([
        '/root/apps/web/src/app.ts',
        '/root/apps/web/ios/test.ts',
        '/root/apps/api/src/index.ts',
      ]);
      const coveredFiles = new Set(['/root/apps/web/src/app.ts', '/root/apps/api/src/index.ts']);

      const orphans = findOrphanedFiles(allSourceFiles, coveredFiles);

      expect(orphans).toEqual(['/root/apps/web/ios/test.ts']);
    });

    it('returns empty array when all files are covered', async () => {
      const { findOrphanedFiles } = await import('./verify-typecheck-coverage.js');

      const allSourceFiles = new Set(['/root/src/app.ts']);
      const coveredFiles = new Set(['/root/src/app.ts']);

      const orphans = findOrphanedFiles(allSourceFiles, coveredFiles);

      expect(orphans).toEqual([]);
    });

    it('returns all files when nothing is covered', async () => {
      const { findOrphanedFiles } = await import('./verify-typecheck-coverage.js');

      const allSourceFiles = new Set(['/root/a.ts', '/root/b.ts']);
      const coveredFiles = new Set<string>();

      const orphans = findOrphanedFiles(allSourceFiles, coveredFiles);

      expect(orphans).toEqual(['/root/a.ts', '/root/b.ts']);
    });

    it('sorts orphaned files alphabetically', async () => {
      const { findOrphanedFiles } = await import('./verify-typecheck-coverage.js');

      const allSourceFiles = new Set(['/root/z.ts', '/root/a.ts', '/root/m.ts']);
      const coveredFiles = new Set<string>();

      const orphans = findOrphanedFiles(allSourceFiles, coveredFiles);

      expect(orphans).toEqual(['/root/a.ts', '/root/m.ts', '/root/z.ts']);
    });
  });

  describe('formatReport', () => {
    it('returns success message when no orphans', async () => {
      const { formatReport } = await import('./verify-typecheck-coverage.js');

      const result = formatReport([], '/root');

      expect(result).toContain('All TypeScript files are covered');
    });

    it('lists orphaned files with relative paths', async () => {
      const { formatReport } = await import('./verify-typecheck-coverage.js');

      const result = formatReport(
        ['/root/apps/web/ios/test.ts', '/root/apps/web/android/test.ts'],
        '/root'
      );

      expect(result).toContain('apps/web/ios/test.ts');
      expect(result).toContain('apps/web/android/test.ts');
      expect(result).toContain('2 TypeScript file(s)');
    });
  });

  describe('findAllTsconfigs', () => {
    it('discovers tsconfig.json files from workspace directories', async () => {
      const { findAllTsconfigs } = await import('./verify-typecheck-coverage.js');
      const { discoverWorkspaces } = await import('./workspaces.js');

      vi.mocked(discoverWorkspaces).mockReturnValue([
        { name: 'web', path: 'apps/web', fullName: '@hushbox/web' },
        { name: 'api', path: 'apps/api', fullName: '@hushbox/api' },
      ]);

      await mkdir(path.join(TEST_DIR, 'apps/web'), { recursive: true });
      await mkdir(path.join(TEST_DIR, 'apps/api'), { recursive: true });
      await writeFile(path.join(TEST_DIR, 'apps/web/tsconfig.json'), '{}');
      await writeFile(path.join(TEST_DIR, 'apps/web/tsconfig.native-tests.json'), '{}');
      await writeFile(path.join(TEST_DIR, 'apps/api/tsconfig.json'), '{}');
      await writeFile(path.join(TEST_DIR, 'tsconfig.json'), '{}');

      const tsconfigs = findAllTsconfigs(TEST_DIR);

      expect(tsconfigs).toContain(path.join(TEST_DIR, 'tsconfig.json'));
      expect(tsconfigs).toContain(path.join(TEST_DIR, 'apps/web/tsconfig.json'));
      expect(tsconfigs).toContain(path.join(TEST_DIR, 'apps/web/tsconfig.native-tests.json'));
      expect(tsconfigs).toContain(path.join(TEST_DIR, 'apps/api/tsconfig.json'));
    });

    it('excludes node_modules tsconfig files', async () => {
      const { findAllTsconfigs } = await import('./verify-typecheck-coverage.js');
      const { discoverWorkspaces } = await import('./workspaces.js');

      vi.mocked(discoverWorkspaces).mockReturnValue([
        { name: 'web', path: 'apps/web', fullName: '@hushbox/web' },
      ]);

      await mkdir(path.join(TEST_DIR, 'apps/web'), { recursive: true });
      await mkdir(path.join(TEST_DIR, 'apps/web/node_modules/pkg'), { recursive: true });
      await writeFile(path.join(TEST_DIR, 'apps/web/tsconfig.json'), '{}');
      await writeFile(path.join(TEST_DIR, 'apps/web/node_modules/pkg/tsconfig.json'), '{}');
      await writeFile(path.join(TEST_DIR, 'tsconfig.json'), '{}');

      const tsconfigs = findAllTsconfigs(TEST_DIR);

      expect(tsconfigs).not.toContain(
        path.join(TEST_DIR, 'apps/web/node_modules/pkg/tsconfig.json')
      );
    });

    it('skips workspaces whose directory does not exist', async () => {
      const { findAllTsconfigs } = await import('./verify-typecheck-coverage.js');

      await writeFile(path.join(TEST_DIR, 'tsconfig.json'), '{}');

      const tsconfigs = findAllTsconfigs(TEST_DIR, [
        { name: 'ghost', path: 'apps/ghost', fullName: '@hushbox/ghost' },
      ]);

      expect(tsconfigs).toEqual([path.join(TEST_DIR, 'tsconfig.json')]);
    });

    it('omits the root tsconfig when it is absent', async () => {
      const { findAllTsconfigs } = await import('./verify-typecheck-coverage.js');
      // TEST_DIR has no root tsconfig.json, so the root entry is skipped.
      const tsconfigs = findAllTsconfigs(TEST_DIR, []);
      expect(tsconfigs).toEqual([]);
    });
  });

  describe('findAllSourceFiles', () => {
    it('skips directories that do not exist', async () => {
      const { findAllSourceFiles } = await import('./verify-typecheck-coverage.js');
      expect(findAllSourceFiles([path.join(TEST_DIR, 'does-not-exist')])).toEqual([]);
    });
  });

  describe('getFilesFromTsconfig', () => {
    it('returns source files covered by a tsconfig include pattern', async () => {
      const { getFilesFromTsconfig } = await import('./verify-typecheck-coverage.js');

      await mkdir(path.join(TEST_DIR, 'src'), { recursive: true });
      await writeFile(
        path.join(TEST_DIR, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: { skipLibCheck: true, noEmit: true, types: [] },
          include: ['src/**/*.ts'],
        })
      );
      await writeFile(path.join(TEST_DIR, 'src/app.ts'), 'export const x = 1;\n');
      await writeFile(path.join(TEST_DIR, 'src/util.ts'), 'export const y = 2;\n');

      const files = getFilesFromTsconfig(path.join(TEST_DIR, 'tsconfig.json'));

      expect(files.some((f) => f.endsWith('src/app.ts'))).toBe(true);
      expect(files.some((f) => f.endsWith('src/util.ts'))).toBe(true);
    });

    it('returns empty array when the tsconfig cannot be parsed', async () => {
      const { getFilesFromTsconfig } = await import('./verify-typecheck-coverage.js');

      const files = getFilesFromTsconfig(path.join(TEST_DIR, 'does-not-exist.json'));

      expect(files).toEqual([]);
    });

    it('warns and returns empty array when the config matches no files', async () => {
      const { getFilesFromTsconfig } = await import('./verify-typecheck-coverage.js');
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await writeFile(path.join(TEST_DIR, 'tsconfig.json'), JSON.stringify({ files: [] }));

      const files = getFilesFromTsconfig(path.join(TEST_DIR, 'tsconfig.json'));

      expect(files).toEqual([]);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain("The 'files' list in config file");
    });

    it('formats a file-anchored diagnostic when a compiler option is unknown', async () => {
      const { getFilesFromTsconfig } = await import('./verify-typecheck-coverage.js');
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // An unknown compiler-option key yields a diagnostic anchored to a position
      // in the tsconfig file, so formatting exercises the host's file-name and
      // current-dir callbacks (a fileless diagnostic never invokes them).
      await writeFile(
        path.join(TEST_DIR, 'tsconfig.json'),
        JSON.stringify({ compilerOptions: { totallyBogusOptionKey: true }, include: ['zzz-none'] })
      );

      const files = getFilesFromTsconfig(path.join(TEST_DIR, 'tsconfig.json'));

      expect(files).toEqual([]);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it('filters out files inside node_modules', async () => {
      const { getFilesFromTsconfig } = await import('./verify-typecheck-coverage.js');

      await mkdir(path.join(TEST_DIR, 'src'), { recursive: true });
      await writeFile(
        path.join(TEST_DIR, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: { skipLibCheck: true, noEmit: true, types: [] },
          include: ['src/**/*.ts'],
        })
      );
      await writeFile(path.join(TEST_DIR, 'src/app.ts'), 'export const x = 1;\n');

      const files = getFilesFromTsconfig(path.join(TEST_DIR, 'tsconfig.json'));

      expect(files.some((f) => f.endsWith('src/app.ts'))).toBe(true);
      expect(files.every((f) => !f.includes('/node_modules/'))).toBe(true);
    });

    it('resolves files through tsconfig "extends"', async () => {
      const { getFilesFromTsconfig } = await import('./verify-typecheck-coverage.js');

      await mkdir(path.join(TEST_DIR, 'src'), { recursive: true });
      await writeFile(
        path.join(TEST_DIR, 'tsconfig.base.json'),
        JSON.stringify({
          compilerOptions: {
            skipLibCheck: true,
            noEmit: true,
            strict: true,
            types: [],
          },
        })
      );
      await writeFile(
        path.join(TEST_DIR, 'tsconfig.json'),
        JSON.stringify({
          extends: './tsconfig.base.json',
          include: ['src/**/*.ts'],
        })
      );
      await writeFile(path.join(TEST_DIR, 'src/app.ts'), 'export const x: number = 1;\n');

      const files = getFilesFromTsconfig(path.join(TEST_DIR, 'tsconfig.json'));

      expect(files.some((f) => f.endsWith('src/app.ts'))).toBe(true);
    });

    it('returns transitively imported files outside the include pattern', async () => {
      const { getFilesFromTsconfig } = await import('./verify-typecheck-coverage.js');

      await mkdir(path.join(TEST_DIR, 'src'), { recursive: true });
      await mkdir(path.join(TEST_DIR, 'lib'), { recursive: true });
      await writeFile(
        path.join(TEST_DIR, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: { skipLibCheck: true, noEmit: true, types: [] },
          include: ['src/entry.ts'],
        })
      );
      await writeFile(
        path.join(TEST_DIR, 'src/entry.ts'),
        "import { helper } from '../lib/util.js';\nexport const x = helper();\n"
      );
      await writeFile(
        path.join(TEST_DIR, 'lib/util.ts'),
        'export function helper(): number {\n  return 1;\n}\n'
      );

      const files = getFilesFromTsconfig(path.join(TEST_DIR, 'tsconfig.json'));

      // entry.ts is in `include`; util.ts is not, but is reachable via import
      expect(files.some((f) => f.endsWith('src/entry.ts'))).toBe(true);
      expect(files.some((f) => f.endsWith('lib/util.ts'))).toBe(true);
    });
  });

  describe('findAllSourceFiles', () => {
    it('finds .ts and .tsx files recursively in specified directories', async () => {
      const { findAllSourceFiles } = await import('./verify-typecheck-coverage.js');

      await mkdir(path.join(TEST_DIR, 'src'), { recursive: true });
      await writeFile(path.join(TEST_DIR, 'src/app.ts'), '');
      await writeFile(path.join(TEST_DIR, 'src/component.tsx'), '');

      const files = findAllSourceFiles([TEST_DIR]);

      expect(files).toContain(path.join(TEST_DIR, 'src/app.ts'));
      expect(files).toContain(path.join(TEST_DIR, 'src/component.tsx'));
    });

    it('excludes node_modules directories', async () => {
      const { findAllSourceFiles } = await import('./verify-typecheck-coverage.js');

      await mkdir(path.join(TEST_DIR, 'src'), { recursive: true });
      await mkdir(path.join(TEST_DIR, 'node_modules/pkg'), { recursive: true });
      await writeFile(path.join(TEST_DIR, 'src/app.ts'), '');
      await writeFile(path.join(TEST_DIR, 'node_modules/pkg/index.ts'), '');

      const files = findAllSourceFiles([TEST_DIR]);

      expect(files).toContain(path.join(TEST_DIR, 'src/app.ts'));
      expect(files).not.toContain(path.join(TEST_DIR, 'node_modules/pkg/index.ts'));
    });

    it('excludes .d.ts files', async () => {
      const { findAllSourceFiles } = await import('./verify-typecheck-coverage.js');

      await mkdir(path.join(TEST_DIR, 'src'), { recursive: true });
      await writeFile(path.join(TEST_DIR, 'src/app.ts'), '');
      await writeFile(path.join(TEST_DIR, 'src/types.d.ts'), '');

      const files = findAllSourceFiles([TEST_DIR]);

      expect(files).toContain(path.join(TEST_DIR, 'src/app.ts'));
      expect(files).not.toContain(path.join(TEST_DIR, 'src/types.d.ts'));
    });

    it('excludes dist and build directories', async () => {
      const { findAllSourceFiles } = await import('./verify-typecheck-coverage.js');

      await mkdir(path.join(TEST_DIR, 'src'), { recursive: true });
      await mkdir(path.join(TEST_DIR, 'dist'), { recursive: true });
      await mkdir(path.join(TEST_DIR, 'build'), { recursive: true });
      await writeFile(path.join(TEST_DIR, 'src/app.ts'), '');
      await writeFile(path.join(TEST_DIR, 'dist/app.ts'), '');
      await writeFile(path.join(TEST_DIR, 'build/app.ts'), '');

      const files = findAllSourceFiles([TEST_DIR]);

      expect(files).toContain(path.join(TEST_DIR, 'src/app.ts'));
      expect(files).not.toContain(path.join(TEST_DIR, 'dist/app.ts'));
      expect(files).not.toContain(path.join(TEST_DIR, 'build/app.ts'));
    });

    it('excludes generated files', async () => {
      const { findAllSourceFiles } = await import('./verify-typecheck-coverage.js');

      await mkdir(path.join(TEST_DIR, 'src'), { recursive: true });
      await mkdir(path.join(TEST_DIR, '.astro'), { recursive: true });
      await writeFile(path.join(TEST_DIR, 'src/app.ts'), '');
      await writeFile(path.join(TEST_DIR, 'src/routeTree.gen.ts'), '');
      await writeFile(path.join(TEST_DIR, '.astro/types.d.ts'), '');

      const files = findAllSourceFiles([TEST_DIR]);

      expect(files).toContain(path.join(TEST_DIR, 'src/app.ts'));
      expect(files).not.toContain(path.join(TEST_DIR, 'src/routeTree.gen.ts'));
      expect(files).not.toContain(path.join(TEST_DIR, '.astro/types.d.ts'));
    });

    it('only scans specified directories, ignoring others at the same level', async () => {
      const { findAllSourceFiles } = await import('./verify-typecheck-coverage.js');

      const workspaceDir = path.join(TEST_DIR, 'apps/web');
      const strayDir = path.join(TEST_DIR, 'OldProject');
      await mkdir(path.join(workspaceDir, 'src'), { recursive: true });
      await mkdir(strayDir, { recursive: true });
      await writeFile(path.join(workspaceDir, 'src/app.ts'), '');
      await writeFile(path.join(strayDir, 'stray.ts'), '');

      const files = findAllSourceFiles([workspaceDir]);

      expect(files).toContain(path.join(workspaceDir, 'src/app.ts'));
      expect(files).not.toContain(path.join(strayDir, 'stray.ts'));
    });

    it('excludes legacy-prefixed files', async () => {
      const { findAllSourceFiles } = await import('./verify-typecheck-coverage.js');

      await mkdir(path.join(TEST_DIR, 'src'), { recursive: true });
      await writeFile(path.join(TEST_DIR, 'src/app.ts'), '');
      await writeFile(path.join(TEST_DIR, 'src/legacy_seed.ts'), '');

      const files = findAllSourceFiles([TEST_DIR]);

      expect(files).toContain(path.join(TEST_DIR, 'src/app.ts'));
      expect(files).not.toContain(path.join(TEST_DIR, 'src/legacy_seed.ts'));
    });

    it('excludes legacy-named directory trees', async () => {
      const { findAllSourceFiles } = await import('./verify-typecheck-coverage.js');

      await mkdir(path.join(TEST_DIR, 'src/legacy'), { recursive: true });
      await mkdir(path.join(TEST_DIR, 'src/legacy-zod'), { recursive: true });
      await writeFile(path.join(TEST_DIR, 'src/app.ts'), '');
      await writeFile(path.join(TEST_DIR, 'src/legacy/old.ts'), '');
      await writeFile(path.join(TEST_DIR, 'src/legacy-zod/index.ts'), '');

      const files = findAllSourceFiles([TEST_DIR]);

      expect(files).toContain(path.join(TEST_DIR, 'src/app.ts'));
      expect(files).not.toContain(path.join(TEST_DIR, 'src/legacy/old.ts'));
      expect(files).not.toContain(path.join(TEST_DIR, 'src/legacy-zod/index.ts'));
    });

    it('keeps files whose names merely contain the word legacy', async () => {
      const { findAllSourceFiles } = await import('./verify-typecheck-coverage.js');

      await mkdir(path.join(TEST_DIR, 'src'), { recursive: true });
      await writeFile(path.join(TEST_DIR, 'src/legacyFormatter.ts'), '');

      const files = findAllSourceFiles([TEST_DIR]);

      expect(files).toContain(path.join(TEST_DIR, 'src/legacyFormatter.ts'));
    });
  });

  describe('verify', () => {
    it('returns success when all source files are covered', async () => {
      const { verify } = await import('./verify-typecheck-coverage.js');
      const { discoverWorkspaces } = await import('./workspaces.js');

      vi.mocked(discoverWorkspaces).mockReturnValue([
        { name: 'pkg', path: 'pkg', fullName: '@test/pkg' },
      ]);

      await mkdir(path.join(TEST_DIR, 'pkg/src'), { recursive: true });
      await writeFile(
        path.join(TEST_DIR, 'pkg/tsconfig.json'),
        JSON.stringify({
          compilerOptions: { skipLibCheck: true, noEmit: true, types: [] },
          include: ['src/**/*.ts'],
        })
      );
      await writeFile(
        path.join(TEST_DIR, 'tsconfig.json'),
        JSON.stringify({ compilerOptions: { skipLibCheck: true, noEmit: true, types: [] } })
      );
      await writeFile(path.join(TEST_DIR, 'pkg/src/index.ts'), 'export const x = 1;\n');

      const result = verify(TEST_DIR);

      expect(result.success).toBe(true);
      expect(result.orphanedFiles).toEqual([]);
    });

    it('returns failure when source files are not covered', async () => {
      const { verify } = await import('./verify-typecheck-coverage.js');
      const { discoverWorkspaces } = await import('./workspaces.js');

      vi.mocked(discoverWorkspaces).mockReturnValue([
        { name: 'pkg', path: 'pkg', fullName: '@test/pkg' },
      ]);

      await mkdir(path.join(TEST_DIR, 'pkg/src'), { recursive: true });
      await mkdir(path.join(TEST_DIR, 'pkg/orphan'), { recursive: true });
      // pkg tsconfig only covers src/, leaving orphan/ uncovered
      await writeFile(
        path.join(TEST_DIR, 'pkg/tsconfig.json'),
        JSON.stringify({
          compilerOptions: { skipLibCheck: true, noEmit: true, types: [] },
          include: ['src/**/*.ts'],
        })
      );
      // Root tsconfig is scoped to a dummy root file so it does NOT fall back
      // to the default "**/*" include that would otherwise pick up orphan/lost.ts
      await writeFile(path.join(TEST_DIR, 'root.ts'), 'export {};\n');
      await writeFile(
        path.join(TEST_DIR, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: { skipLibCheck: true, noEmit: true, types: [] },
          include: ['root.ts'],
        })
      );
      await writeFile(path.join(TEST_DIR, 'pkg/src/index.ts'), 'export const x = 1;\n');
      await writeFile(path.join(TEST_DIR, 'pkg/orphan/lost.ts'), 'export const y = 2;\n');

      const result = verify(TEST_DIR);

      expect(result.success).toBe(false);
      expect(result.orphanedFiles).toContain(path.join(TEST_DIR, 'pkg/orphan/lost.ts'));
    });
  });
});
