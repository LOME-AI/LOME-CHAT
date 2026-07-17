import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  countPlacedReveals,
  generateBannerGif,
  generateBanners,
  patchCryptoWithSeed,
} from './generate-banner.js';
import { getBrandColors } from './brand.js';

describe('patchCryptoWithSeed', () => {
  it('makes crypto.getRandomValues deterministic for a given seed', () => {
    patchCryptoWithSeed('seed-a');
    const a1 = new Uint32Array(4);
    crypto.getRandomValues(a1);

    patchCryptoWithSeed('seed-a');
    const a2 = new Uint32Array(4);
    crypto.getRandomValues(a2);

    expect([...a1]).toEqual([...a2]);
  });

  it('produces different sequences for different seeds', () => {
    patchCryptoWithSeed('seed-a');
    const a = new Uint32Array(4);
    crypto.getRandomValues(a);

    patchCryptoWithSeed('seed-b');
    const b = new Uint32Array(4);
    crypto.getRandomValues(b);

    expect([...a]).not.toEqual([...b]);
  });
});

describe('generateBanners', () => {
  let temporaryDir: string;

  beforeEach(() => {
    temporaryDir = mkdtempSync(path.join(tmpdir(), 'banner-test-'));
  });

  afterEach(() => {
    rmSync(temporaryDir, { recursive: true, force: true });
  });

  it('creates both banner-dark.gif and banner-light.gif with non-trivial size', () => {
    const repoRoot = path.resolve(import.meta.dirname, '../..');
    generateBanners(temporaryDir, repoRoot);

    const files = readdirSync(temporaryDir);
    expect(files).toContain('banner-dark.gif');
    expect(files).toContain('banner-light.gif');

    const darkSize = statSync(path.join(temporaryDir, 'banner-dark.gif')).size;
    const lightSize = statSync(path.join(temporaryDir, 'banner-light.gif')).size;
    expect(darkSize).toBeGreaterThan(10_000);
    expect(lightSize).toBeGreaterThan(10_000);
  }, 180_000);

  it('defaults the repo root to the process cwd when omitted', () => {
    const repoRoot = path.resolve(import.meta.dirname, '../..');
    const previousCwd = process.cwd();
    process.chdir(repoRoot);
    try {
      generateBanners(temporaryDir);
      expect(readdirSync(temporaryDir)).toContain('banner-dark.gif');
    } finally {
      process.chdir(previousCwd);
    }
  }, 180_000);
});

describe('countPlacedReveals', () => {
  const repoRoot = path.resolve(import.meta.dirname, '../..');
  const theme = getBrandColors(repoRoot).dark;

  it('counts reveals deterministically for a seed', () => {
    const first = countPlacedReveals(theme, { seed: 'reveal-seed', durationSeconds: 2 });
    const second = countPlacedReveals(theme, { seed: 'reveal-seed', durationSeconds: 2 });

    expect(first).toBeGreaterThan(0);
    expect(second).toBe(first);
  });

  it('keeps placing new reveals as the animation runs', () => {
    const initialOnly = countPlacedReveals(theme, { seed: 'reveal-seed', durationSeconds: 0 });
    const afterRunning = countPlacedReveals(theme, { seed: 'reveal-seed', durationSeconds: 5 });

    expect(afterRunning).toBeGreaterThan(initialOnly);
  });

  it('runs the full default duration when no options are given', () => {
    const placed = countPlacedReveals(theme);

    expect(placed).toBeGreaterThan(0);
  });
});

describe('generateBannerGif', () => {
  const repoRoot = path.resolve(import.meta.dirname, '../..');
  const theme = getBrandColors(repoRoot).dark;
  let temporaryDir: string;

  beforeEach(() => {
    temporaryDir = mkdtempSync(path.join(tmpdir(), 'banner-gif-test-'));
  });

  afterEach(() => {
    rmSync(temporaryDir, { recursive: true, force: true });
  });

  it('renders a non-trivial GIF using the default seed when no options are given', () => {
    const output = path.join(temporaryDir, 'banner.gif');

    generateBannerGif(output, theme);

    expect(statSync(output).size).toBeGreaterThan(10_000);
  }, 180_000);
});
