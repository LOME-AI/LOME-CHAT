// @ts-check
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Loads every topic-named ESLint extension file from a directory.
 *
 * Contract (documented in README.md next to this file): each file matching
 * `*.config.mjs` directly inside the directory must default-export an ARRAY of
 * flat-config entries. Files are loaded in lexicographic filename order so the
 * composed config is deterministic. Any malformed extension fails loudly — a
 * broken file must break lint, never be silently skipped.
 *
 * @param {string | URL} extensionsDir - Directory containing `*.config.mjs` files.
 * @returns {Promise<import('eslint').Linter.Config[]>} Concatenated flat-config entries.
 */
export async function loadEslintExtensions(extensionsDir) {
  const dir =
    extensionsDir instanceof URL ? extensionsDir : pathToFileURL(path.resolve(extensionsDir) + '/');
  const entries = await readdir(dir, { withFileTypes: true });
  const extensionFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.config.mjs'))
    .map((entry) => entry.name)
    .toSorted();

  /** @type {import('eslint').Linter.Config[]} */
  const configs = [];
  for (const fileName of extensionFiles) {
    const module = await import(new URL(fileName, dir).href);
    if (!Array.isArray(module.default)) {
      throw new TypeError(
        `ESLint extension "${fileName}" must default-export an array of flat-config entries.`
      );
    }
    configs.push(...module.default);
  }
  return configs;
}
