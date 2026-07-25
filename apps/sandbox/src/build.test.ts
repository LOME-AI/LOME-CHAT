import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildSandbox } from './build.js';

describe('buildSandbox', () => {
  let root: string;
  let publicDir: string;
  let distributionDir: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'sandbox-build-'));
    publicDir = path.join(root, 'public');
    distributionDir = path.join(root, 'dist');
    mkdirSync(publicDir);
    writeFileSync(path.join(publicDir, 'render.html'), '<!doctype html>render');
    mkdirSync(path.join(publicDir, 'pyodide'));
    writeFileSync(path.join(publicDir, 'pyodide', 'core.wasm'), Buffer.from([0x00, 0x61]));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('copies the public pages into dist', () => {
    buildSandbox({ publicDir, distDir: distributionDir, configScript: 'globalThis.X=1;' });
    expect(readFileSync(path.join(distributionDir, 'render.html'), 'utf8')).toBe(
      '<!doctype html>render'
    );
  });

  it('copies nested pyodide assets into dist', () => {
    buildSandbox({ publicDir, distDir: distributionDir, configScript: 'globalThis.X=1;' });
    expect(existsSync(path.join(distributionDir, 'pyodide', 'core.wasm'))).toBe(true);
  });

  it('writes the env-derived config.js into dist', () => {
    buildSandbox({ publicDir, distDir: distributionDir, configScript: 'globalThis.X=42;' });
    expect(readFileSync(path.join(distributionDir, 'config.js'), 'utf8')).toBe('globalThis.X=42;');
  });

  it('clears a stale dist so a rebuild leaves no orphaned files', () => {
    mkdirSync(distributionDir);
    writeFileSync(path.join(distributionDir, 'orphan.html'), 'old');
    buildSandbox({ publicDir, distDir: distributionDir, configScript: 'globalThis.X=1;' });
    expect(existsSync(path.join(distributionDir, 'orphan.html'))).toBe(false);
    expect(existsSync(path.join(distributionDir, 'render.html'))).toBe(true);
  });
});
