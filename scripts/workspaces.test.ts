import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  discoverWorkspaces,
  getWorkspaceByName,
  getWorkspacePaths,
  parseWorkspaceYaml,
  expandGlobPattern,
} from './workspaces.js';

describe('workspaces', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = path.join(tmpdir(), `workspaces-test-${String(Date.now())}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  function createWorkspaceYaml(patterns: string[]): void {
    const patternLines = patterns.map((p) => `  - '${p}'`).join('\n');
    const content = `packages:\n${patternLines}\n`;
    writeFileSync(path.join(testDir, 'pnpm-workspace.yaml'), content);
  }

  function createPackage(relativePath: string, name: string): void {
    const fullPath = path.join(testDir, relativePath);
    mkdirSync(fullPath, { recursive: true });
    writeFileSync(path.join(fullPath, 'package.json'), JSON.stringify({ name }));
  }

  describe('parseWorkspaceYaml', () => {
    it('parses pnpm-workspace.yaml correctly', () => {
      createWorkspaceYaml(['apps/*', 'packages/*', 'e2e', 'scripts']);

      const patterns = parseWorkspaceYaml(testDir);

      expect(patterns).toEqual(['apps/*', 'packages/*', 'e2e', 'scripts']);
    });

    it('returns empty array if file does not exist', () => {
      const patterns = parseWorkspaceYaml(testDir);

      expect(patterns).toEqual([]);
    });

    it('returns empty array if packages key is missing', () => {
      writeFileSync(path.join(testDir, 'pnpm-workspace.yaml'), 'other: value\n');

      const patterns = parseWorkspaceYaml(testDir);

      expect(patterns).toEqual([]);
    });
  });

  describe('expandGlobPattern', () => {
    it('expands glob pattern to matching directories', () => {
      mkdirSync(path.join(testDir, 'apps/web'), { recursive: true });
      mkdirSync(path.join(testDir, 'apps/api'), { recursive: true });

      const paths = expandGlobPattern('apps/*', testDir);

      expect(paths.toSorted((a, b) => a.localeCompare(b))).toEqual(['apps/api', 'apps/web']);
    });

    it('returns single path for non-glob pattern', () => {
      mkdirSync(path.join(testDir, 'e2e'), { recursive: true });

      const paths = expandGlobPattern('e2e', testDir);

      expect(paths).toEqual(['e2e']);
    });

    it('returns empty array if pattern matches nothing', () => {
      const paths = expandGlobPattern('nonexistent/*', testDir);

      expect(paths).toEqual([]);
    });

    it('returns empty array for non-glob pattern if directory does not exist', () => {
      const paths = expandGlobPattern('nonexistent', testDir);

      expect(paths).toEqual([]);
    });

    it('expands a bare * pattern to top-level directories without a prefix', () => {
      mkdirSync(path.join(testDir, 'alpha'), { recursive: true });
      mkdirSync(path.join(testDir, 'beta'), { recursive: true });

      const paths = expandGlobPattern('*', testDir);

      expect(paths.toSorted((a, b) => a.localeCompare(b))).toEqual(['alpha', 'beta']);
    });
  });

  describe('discoverWorkspaces', () => {
    it('discovers all workspaces from pnpm-workspace.yaml', () => {
      createWorkspaceYaml(['apps/*', 'packages/*', 'e2e']);
      createPackage('apps/web', '@hushbox/web');
      createPackage('apps/api', '@hushbox/api');
      createPackage('packages/ui', '@hushbox/ui');
      createPackage('packages/shared', '@hushbox/shared');
      createPackage('e2e', '@hushbox/e2e');

      const workspaces = discoverWorkspaces(testDir);

      expect(workspaces).toHaveLength(5);
      expect(workspaces.map((w) => w.name).toSorted((a, b) => a.localeCompare(b))).toEqual([
        'api',
        'e2e',
        'shared',
        'ui',
        'web',
      ]);
    });

    it('extracts short name from package name', () => {
      createWorkspaceYaml(['apps/*']);
      createPackage('apps/web', '@hushbox/web');

      const workspaces = discoverWorkspaces(testDir);

      expect(workspaces[0]).toEqual({
        name: 'web',
        path: 'apps/web',
        fullName: '@hushbox/web',
      });
    });

    it('uses directory name if package name has no scope', () => {
      createWorkspaceYaml(['apps/*']);
      createPackage('apps/myapp', 'myapp');

      const workspaces = discoverWorkspaces(testDir);

      expect(workspaces[0]?.name).toBe('myapp');
    });

    it('skips directories without package.json', () => {
      createWorkspaceYaml(['apps/*']);
      mkdirSync(path.join(testDir, 'apps/web'), { recursive: true });

      const workspaces = discoverWorkspaces(testDir);

      expect(workspaces).toHaveLength(0);
    });

    it('returns empty array if pnpm-workspace.yaml does not exist', () => {
      const workspaces = discoverWorkspaces(testDir);

      expect(workspaces).toEqual([]);
    });

    it('handles nested glob patterns', () => {
      createWorkspaceYaml(['packages/nested/*']);
      createPackage('packages/nested/foo', '@hushbox/foo');

      const workspaces = discoverWorkspaces(testDir);

      expect(workspaces).toHaveLength(1);
      expect(workspaces[0]?.path).toBe('packages/nested/foo');
    });

    it('falls back to the directory name when the package name ends with a slash', () => {
      createWorkspaceYaml(['apps/*']);
      createPackage('apps/oddball', '@hushbox/');

      const workspaces = discoverWorkspaces(testDir);

      expect(workspaces[0]?.name).toBe('oddball');
    });

    it('defaults to process.cwd() when no root directory is given', () => {
      const originalCwd = process.cwd();
      process.chdir(testDir);
      try {
        createWorkspaceYaml(['apps/*']);
        createPackage('apps/web', '@hushbox/web');

        const workspaces = discoverWorkspaces();

        expect(workspaces.map((w) => w.name)).toEqual(['web']);
      } finally {
        process.chdir(originalCwd);
      }
    });
  });

  describe('getWorkspaceByName', () => {
    beforeEach(() => {
      createWorkspaceYaml(['apps/*', 'packages/*']);
      createPackage('apps/web', '@hushbox/web');
      createPackage('apps/api', '@hushbox/api');
      createPackage('packages/ui', '@hushbox/ui');
    });

    it('returns workspace by short name', () => {
      const workspace = getWorkspaceByName('web', testDir);

      expect(workspace).toEqual({
        name: 'web',
        path: 'apps/web',
        fullName: '@hushbox/web',
      });
    });

    it('returns undefined for unknown workspace', () => {
      const workspace = getWorkspaceByName('unknown', testDir);

      expect(workspace).toBeUndefined();
    });

    it('is case-sensitive', () => {
      const workspace = getWorkspaceByName('WEB', testDir);

      expect(workspace).toBeUndefined();
    });
  });

  describe('getWorkspacePaths', () => {
    it('returns all workspace paths', () => {
      createWorkspaceYaml(['apps/*', 'packages/*']);
      createPackage('apps/web', '@hushbox/web');
      createPackage('apps/api', '@hushbox/api');
      createPackage('packages/ui', '@hushbox/ui');

      const paths = getWorkspacePaths(testDir);

      expect(paths.toSorted((a, b) => a.localeCompare(b))).toEqual([
        'apps/api',
        'apps/web',
        'packages/ui',
      ]);
    });

    it('returns empty array if no workspaces', () => {
      const paths = getWorkspacePaths(testDir);

      expect(paths).toEqual([]);
    });
  });

  describe('integration with real project', () => {
    it('discovers workspaces from actual pnpm-workspace.yaml', () => {
      const projectRoot = path.join(import.meta.dirname, '..');
      const workspaces = discoverWorkspaces(projectRoot);

      const names = workspaces.map((w) => w.name);
      expect(names).toContain('web');
      expect(names).toContain('api');
      expect(names).toContain('ui');
      expect(names).toContain('shared');
      expect(names).toContain('db');
      expect(names).toContain('e2e');
      expect(names).toContain('scripts');
    });

    it('getWorkspaceByName works with real project', () => {
      const projectRoot = path.join(import.meta.dirname, '..');
      const workspace = getWorkspaceByName('web', projectRoot);

      expect(workspace).toBeDefined();
      expect(workspace?.path).toBe('apps/web');
      expect(workspace?.fullName).toBe('@hushbox/web');
    });
  });
});
