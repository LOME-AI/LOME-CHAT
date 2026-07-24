import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateBannerGif } from './generate-banner.js';
import { getBrandColors } from './brand.js';

describe('generateBannerGif — light', () => {
  const repoRoot = path.resolve(import.meta.dirname, '../..');
  const theme = getBrandColors(repoRoot).light;
  let temporaryDir: string;

  beforeEach(() => {
    temporaryDir = mkdtempSync(path.join(tmpdir(), 'banner-light-test-'));
  });

  afterEach(() => {
    rmSync(temporaryDir, { recursive: true, force: true });
  });

  it('renders a non-trivial light GIF using an explicit seed', () => {
    const output = path.join(temporaryDir, 'banner-light.gif');

    // Explicit seed: exercises the provided-options branch of generateBannerGif.
    generateBannerGif(output, theme, { seed: 'hushbox-banner-light' });

    expect(statSync(output).size).toBeGreaterThan(10_000);
  }, 180_000);
});
