import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getWorktreeConfig, djb2Hash, BASE_PORTS } from './worktree.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DIR = path.resolve(__dirname, '__test-fixtures-worktree__');

describe('djb2Hash', () => {
  it('returns a non-negative integer', () => {
    const result = djb2Hash('test');
    expect(result).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(result)).toBe(true);
  });

  it('is deterministic', () => {
    expect(djb2Hash('my-worktree')).toBe(djb2Hash('my-worktree'));
  });

  it('produces different values for different inputs', () => {
    expect(djb2Hash('worktree-a')).not.toBe(djb2Hash('worktree-b'));
  });

  it('handles empty string', () => {
    const result = djb2Hash('');
    expect(result).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(result)).toBe(true);
  });
});

describe('getWorktreeConfig', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe('main repo (not a worktree)', () => {
    it('returns slot 0 when .git is a directory', () => {
      mkdirSync(path.join(TEST_DIR, '.git'), { recursive: true });

      const config = getWorktreeConfig(TEST_DIR);

      expect(config.isWorktree).toBe(false);
      expect(config.slot).toBe(0);
    });

    it('defaults to process.cwd() when no root directory is given', () => {
      mkdirSync(path.join(TEST_DIR, '.git'), { recursive: true });
      const originalCwd = process.cwd();
      process.chdir(TEST_DIR);
      try {
        const config = getWorktreeConfig();

        expect(config).toEqual(getWorktreeConfig(TEST_DIR));
      } finally {
        process.chdir(originalCwd);
      }
    });

    it('returns name "main"', () => {
      mkdirSync(path.join(TEST_DIR, '.git'), { recursive: true });

      const config = getWorktreeConfig(TEST_DIR);

      expect(config.name).toBe('main');
    });

    it('returns projectName "hushbox"', () => {
      mkdirSync(path.join(TEST_DIR, '.git'), { recursive: true });

      const config = getWorktreeConfig(TEST_DIR);

      expect(config.projectName).toBe('hushbox');
    });

    it('returns base ports unchanged', () => {
      mkdirSync(path.join(TEST_DIR, '.git'), { recursive: true });

      const config = getWorktreeConfig(TEST_DIR);

      expect(config.ports).toEqual(BASE_PORTS);
    });
  });

  describe('worktree', () => {
    it('returns isWorktree true when .git is a file', () => {
      writeFileSync(
        path.join(TEST_DIR, '.git'),
        'gitdir: /home/user/repo/.git/worktrees/my-feature\n'
      );

      const config = getWorktreeConfig(TEST_DIR);

      expect(config.isWorktree).toBe(true);
    });

    it('extracts worktree name from gitdir path', () => {
      writeFileSync(
        path.join(TEST_DIR, '.git'),
        'gitdir: /home/user/repo/.git/worktrees/my-feature\n'
      );

      const config = getWorktreeConfig(TEST_DIR);

      expect(config.name).toBe('my-feature');
    });

    it('computes slot in range [1, 199]', () => {
      writeFileSync(
        path.join(TEST_DIR, '.git'),
        'gitdir: /home/user/repo/.git/worktrees/my-feature\n'
      );

      const config = getWorktreeConfig(TEST_DIR);

      expect(config.slot).toBeGreaterThanOrEqual(1);
      expect(config.slot).toBeLessThanOrEqual(199);
    });

    it('produces deterministic slot for the same worktree name', () => {
      writeFileSync(
        path.join(TEST_DIR, '.git'),
        'gitdir: /home/user/repo/.git/worktrees/my-feature\n'
      );

      const config1 = getWorktreeConfig(TEST_DIR);
      const config2 = getWorktreeConfig(TEST_DIR);

      expect(config1.slot).toBe(config2.slot);
    });

    it('sets projectName to hushbox-{slot}', () => {
      writeFileSync(
        path.join(TEST_DIR, '.git'),
        'gitdir: /home/user/repo/.git/worktrees/my-feature\n'
      );

      const config = getWorktreeConfig(TEST_DIR);

      expect(config.projectName).toBe(`hushbox-${String(config.slot)}`);
    });

    it('offsets all ports by slot', () => {
      writeFileSync(
        path.join(TEST_DIR, '.git'),
        'gitdir: /home/user/repo/.git/worktrees/my-feature\n'
      );

      const config = getWorktreeConfig(TEST_DIR);
      const slot = config.slot;

      expect(config.ports.vite).toBe(BASE_PORTS.vite + slot);
      expect(config.ports.api).toBe(BASE_PORTS.api + slot);
      expect(config.ports.postgres).toBe(BASE_PORTS.postgres + slot);
      expect(config.ports.neon).toBe(BASE_PORTS.neon + slot);
      expect(config.ports.redis).toBe(BASE_PORTS.redis + slot);
      expect(config.ports.redisHttp).toBe(BASE_PORTS.redisHttp + slot);
      expect(config.ports.astro).toBe(BASE_PORTS.astro + slot);
      expect(config.ports.emulatorAdb).toBe(BASE_PORTS.emulatorAdb + slot);
      expect(config.ports.emulatorVnc).toBe(BASE_PORTS.emulatorVnc + slot);
      expect(config.ports.readmePreview).toBe(BASE_PORTS.readmePreview + slot);
      expect(config.ports.minioApi).toBe(BASE_PORTS.minioApi + slot);
      expect(config.ports.minioConsole).toBe(BASE_PORTS.minioConsole + slot);
      expect(config.ports.studio).toBe(BASE_PORTS.studio + slot);
      expect(config.ports.idleDaemon).toBe(BASE_PORTS.idleDaemon + slot);
    });

    it('produces different slots for different worktree names', () => {
      writeFileSync(
        path.join(TEST_DIR, '.git'),
        'gitdir: /home/user/repo/.git/worktrees/feature-a\n'
      );
      const configA = getWorktreeConfig(TEST_DIR);

      writeFileSync(
        path.join(TEST_DIR, '.git'),
        'gitdir: /home/user/repo/.git/worktrees/feature-b\n'
      );
      const configB = getWorktreeConfig(TEST_DIR);

      expect(configA.slot).not.toBe(configB.slot);
    });

    it('handles gitdir paths with nested directories', () => {
      writeFileSync(
        path.join(TEST_DIR, '.git'),
        'gitdir: /home/user/.superset/projects/HushBox/.git/worktrees/make-the-repo-workspace-parall\n'
      );

      const config = getWorktreeConfig(TEST_DIR);

      expect(config.name).toBe('make-the-repo-workspace-parall');
      expect(config.isWorktree).toBe(true);
    });
  });

  describe('error cases', () => {
    it('throws when .git does not exist', () => {
      expect(() => getWorktreeConfig(TEST_DIR)).toThrow();
    });

    it('throws when .git file has no gitdir line', () => {
      writeFileSync(path.join(TEST_DIR, '.git'), 'something else\n');

      expect(() => getWorktreeConfig(TEST_DIR)).toThrow();
    });
  });
});
