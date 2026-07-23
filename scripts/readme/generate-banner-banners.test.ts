import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateBanners } from './generate-banner.js';

describe('generateBanners', () => {
  let temporaryDir: string;

  beforeEach(() => {
    temporaryDir = mkdtempSync(path.join(tmpdir(), 'banner-test-'));
  });

  afterEach(() => {
    rmSync(temporaryDir, { recursive: true, force: true });
  });

  it('defaults the repo root to the process cwd and writes both dark+light banners with non-trivial size', () => {
    const repoRoot = path.resolve(import.meta.dirname, '../..');
    const previousCwd = process.cwd();
    process.chdir(repoRoot);
    try {
      // No repoRoot argument: exercises the `repoRoot ?? process.cwd()` default.
      generateBanners(temporaryDir);

      const files = readdirSync(temporaryDir);
      expect(files).toContain('banner-dark.gif');
      expect(files).toContain('banner-light.gif');

      const darkSize = statSync(path.join(temporaryDir, 'banner-dark.gif')).size;
      const lightSize = statSync(path.join(temporaryDir, 'banner-light.gif')).size;
      expect(darkSize).toBeGreaterThan(10_000);
      expect(lightSize).toBeGreaterThan(10_000);
    } finally {
      process.chdir(previousCwd);
    }
  }, 180_000);
});
