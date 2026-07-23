import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateBannerGif } from './generate-banner.js';
import { getBrandColors } from './brand.js';

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
