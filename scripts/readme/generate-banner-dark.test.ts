import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateBannerGif } from './generate-banner.js';
import { getBrandColors } from './brand.js';

describe('generateBannerGif — dark', () => {
  const repoRoot = path.resolve(import.meta.dirname, '../..');
  const theme = getBrandColors(repoRoot).dark;
  let temporaryDir: string;

  beforeEach(() => {
    temporaryDir = mkdtempSync(path.join(tmpdir(), 'banner-dark-test-'));
  });

  afterEach(() => {
    rmSync(temporaryDir, { recursive: true, force: true });
  });

  it('renders a non-trivial dark GIF using the default seed when no options are given', () => {
    const output = path.join(temporaryDir, 'banner-dark.gif');

    // No options: exercises the default-seed branch of generateBannerGif.
    generateBannerGif(output, theme);

    expect(statSync(output).size).toBeGreaterThan(10_000);
  }, 180_000);
});
