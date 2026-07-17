import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateOgDefault, OG_HEIGHT, OG_WIDTH } from './generate-og-image.js';

/**
 * Read width/height from a PNG's IHDR chunk. The IHDR is always the first
 * chunk and starts at byte 16 (8-byte signature + 4-byte length + 4-byte
 * "IHDR" type), with width then height as big-endian uint32.
 */
function readPngDimensions(buffer: Buffer): { width: number; height: number } {
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

describe('generateOgDefault', () => {
  let temporaryDir: string;

  beforeEach(() => {
    temporaryDir = mkdtempSync(path.join(tmpdir(), 'og-test-'));
  });

  afterEach(() => {
    rmSync(temporaryDir, { recursive: true, force: true });
  });

  it('writes og-default.png into the output directory', async () => {
    const repoRoot = path.resolve(import.meta.dirname, '..');
    await generateOgDefault(temporaryDir, repoRoot);

    expect(readdirSync(temporaryDir)).toContain('og-default.png');
  });

  it('produces a non-trivial PNG file', async () => {
    const repoRoot = path.resolve(import.meta.dirname, '..');
    await generateOgDefault(temporaryDir, repoRoot);

    const size = statSync(path.join(temporaryDir, 'og-default.png')).size;
    expect(size).toBeGreaterThan(5000);
  });

  it('produces a 1200x630 image', async () => {
    const repoRoot = path.resolve(import.meta.dirname, '..');
    await generateOgDefault(temporaryDir, repoRoot);

    const buffer = readFileSync(path.join(temporaryDir, 'og-default.png'));
    const { width, height } = readPngDimensions(buffer);
    expect(width).toBe(OG_WIDTH);
    expect(height).toBe(OG_HEIGHT);
    expect(OG_WIDTH).toBe(1200);
    expect(OG_HEIGHT).toBe(630);
  });

  it('defaults the repo root to the process cwd when omitted', async () => {
    const repoRoot = path.resolve(import.meta.dirname, '..');
    const previousCwd = process.cwd();
    process.chdir(repoRoot);
    try {
      await generateOgDefault(temporaryDir);
      expect(readdirSync(temporaryDir)).toContain('og-default.png');
    } finally {
      process.chdir(previousCwd);
    }
  });
});
