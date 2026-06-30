import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { loadEslintExtensions } from './load-extensions.mjs';

const temporaryDirectories = [];

function makeExtensionsDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'eslint-extensions-'));
  temporaryDirectories.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('loadEslintExtensions', () => {
  it('returns an empty array for a directory with no extension files', async () => {
    const dir = makeExtensionsDir();
    writeFileSync(path.join(dir, 'README.md'), '# docs');

    await expect(loadEslintExtensions(dir)).resolves.toEqual([]);
  });

  it('loads flat-config entries from a *.config.mjs file', async () => {
    const dir = makeExtensionsDir();
    writeFileSync(
      path.join(dir, 'example.config.mjs'),
      "export default [{ files: ['**/*.ts'], rules: { 'no-console': 'error' } }];\n"
    );

    const entries = await loadEslintExtensions(dir);

    expect(entries).toEqual([{ files: ['**/*.ts'], rules: { 'no-console': 'error' } }]);
  });

  it('concatenates entries from multiple files in lexicographic filename order', async () => {
    const dir = makeExtensionsDir();
    writeFileSync(path.join(dir, 'b.config.mjs'), "export default [{ name: 'second' }];\n");
    writeFileSync(path.join(dir, 'a.config.mjs'), "export default [{ name: 'first' }];\n");

    const entries = await loadEslintExtensions(dir);

    expect(entries.map((entry) => entry.name)).toEqual(['first', 'second']);
  });

  it('ignores helper .mjs files that do not match *.config.mjs', async () => {
    const dir = makeExtensionsDir();
    writeFileSync(path.join(dir, 'helper.mjs'), 'export const helper = true;\n');
    writeFileSync(path.join(dir, 'example.config.mjs'), "export default [{ name: 'only' }];\n");

    const entries = await loadEslintExtensions(dir);

    expect(entries.map((entry) => entry.name)).toEqual(['only']);
  });

  it('ignores subdirectories', async () => {
    const dir = makeExtensionsDir();
    mkdirSync(path.join(dir, 'nested.config.mjs'));
    const entries = await loadEslintExtensions(dir);

    expect(entries).toEqual([]);
  });

  it('throws naming the file when the default export is not an array', async () => {
    const dir = makeExtensionsDir();
    writeFileSync(path.join(dir, 'broken.config.mjs'), 'export default { not: "an array" };\n');

    await expect(loadEslintExtensions(dir)).rejects.toThrow('broken.config.mjs');
  });

  it('throws naming the file when there is no default export', async () => {
    const dir = makeExtensionsDir();
    writeFileSync(path.join(dir, 'no-default.config.mjs'), 'export const x = [];\n');

    await expect(loadEslintExtensions(dir)).rejects.toThrow('no-default.config.mjs');
  });

  it('propagates import errors from a broken extension file', async () => {
    const dir = makeExtensionsDir();
    writeFileSync(path.join(dir, 'throws.config.mjs'), "throw new Error('boom');\n");

    await expect(loadEslintExtensions(dir)).rejects.toThrow('boom');
  });

  it('accepts a file URL for the extensions directory', async () => {
    const dir = makeExtensionsDir();
    writeFileSync(path.join(dir, 'url.config.mjs'), "export default [{ name: 'via-url' }];\n");

    const entries = await loadEslintExtensions(pathToFileURL(dir + '/'));

    expect(entries.map((entry) => entry.name)).toEqual(['via-url']);
  });

  it('throws when the directory does not exist', async () => {
    await expect(loadEslintExtensions('/nonexistent/extensions-dir')).rejects.toThrow(
      /ENOENT|no such file/i
    );
  });
});
