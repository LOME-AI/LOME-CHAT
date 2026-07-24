import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateBanners, type GenerateBannerGifOptions } from './generate-banner.js';
import { getBrandColors, type ThemeColors } from './brand.js';

interface RenderCall {
  outputPath: string;
  theme: ThemeColors;
  seed: string | undefined;
}

describe('generateBanners', () => {
  let temporaryDir: string;

  beforeEach(() => {
    temporaryDir = mkdtempSync(path.join(tmpdir(), 'banner-test-'));
  });

  afterEach(() => {
    rmSync(temporaryDir, { recursive: true, force: true });
  });

  it('renders dark then light through the injected renderer with per-variant seeds, defaulting repoRoot to cwd', () => {
    const repoRoot = path.resolve(import.meta.dirname, '../..');
    const brand = getBrandColors(repoRoot);
    const calls: RenderCall[] = [];
    // Injected renderer: records its arguments and writes a stub file so the
    // cache's output-existence check sees both banners. Keeps the wrapper test
    // free of a real (~114s) GIF render — the renders are exercised by the
    // per-variant files.
    const fakeRender = (
      outputPath: string,
      theme: ThemeColors,
      options?: GenerateBannerGifOptions
    ): void => {
      calls.push({ outputPath, theme, seed: options?.seed });
      writeFileSync(outputPath, 'stub');
    };

    const previousCwd = process.cwd();
    process.chdir(repoRoot);
    try {
      // No repoRoot argument: exercises the `repoRoot ?? process.cwd()` default
      // against the real source tree (cold cache in a fresh temp outputDir).
      generateBanners(temporaryDir, undefined, fakeRender);
    } finally {
      process.chdir(previousCwd);
    }

    const darkPath = path.join(temporaryDir, 'banner-dark.gif');
    const lightPath = path.join(temporaryDir, 'banner-light.gif');

    expect(calls).toEqual([
      { outputPath: darkPath, theme: brand.dark, seed: 'hushbox-banner-dark' },
      { outputPath: lightPath, theme: brand.light, seed: 'hushbox-banner-light' },
    ]);
    expect(existsSync(darkPath)).toBe(true);
    expect(existsSync(lightPath)).toBe(true);
  });
});
