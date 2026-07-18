import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { downloadBinary, takeFileName } from './download.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of temporaryDirectories) {
    rmSync(dir, { recursive: true, force: true });
  }
  temporaryDirectories.length = 0;
});

function temporaryPath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'download-'));
  temporaryDirectories.push(dir);
  return path.join(dir, 'out.bin');
}

describe('takeFileName', () => {
  it('builds the archive name from scene, take, model, and extension', () => {
    expect(takeFileName(3, 2, 'seedance20', 'mp4')).toBe('s3-take2-seedance20.mp4');
  });
});

describe('downloadBinary', () => {
  it('writes the fetched bytes and returns their length', async () => {
    const payload = Buffer.from([1, 2, 3, 4, 5]);
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(payload)))
    );
    const destination = temporaryPath();

    const written = await downloadBinary('https://example.test/clip.mp4', destination);

    expect(written).toBe(5);
    expect(readFileSync(destination)).toEqual(payload);
  });

  it('throws when the response status is not ok', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('nope', { status: 404 })))
    );

    await expect(
      downloadBinary('https://example.test/missing.mp4', temporaryPath())
    ).rejects.toThrow(/HTTP 404/);
  });
});
