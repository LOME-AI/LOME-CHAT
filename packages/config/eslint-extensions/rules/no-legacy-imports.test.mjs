// Programmatic ESLint tests for the vendored no-legacy-imports rule.
// Deliberately independent of the eslint-extensions loader (same pattern as
// the other rule suites): the extension config is applied directly to fixture
// code, so these tests stay valid regardless of loader behavior.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import extensionConfig from '../no-legacy-imports.config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, '__test-fixtures-no-legacy-imports__');

function createLinter() {
  return new ESLint({
    cwd: fixturesDir,
    overrideConfigFile: true,
    overrideConfig: [
      { files: ['**/*.ts'], languageOptions: { parser: tseslint.parser } },
      ...extensionConfig,
    ],
  });
}

async function lintFixture(file) {
  const linter = createLinter();
  const results = await linter.lintFiles([path.join(fixturesDir, file)]);
  return results[0].messages.filter((m) => m.ruleId === 'legacy/no-legacy-imports');
}

async function lintAtPath(code, filePath) {
  const linter = createLinter();
  const [result] = await linter.lintText(code, {
    filePath: path.join(fixturesDir, ...filePath.split('/')),
  });
  return result.messages.filter((m) => m.ruleId === 'legacy/no-legacy-imports');
}

describe('no-legacy-imports', () => {
  it('flags an import that reaches into the /legacy/ tree', async () => {
    expect(await lintFixture('src/new-code/imports-legacy-tree.ts')).toHaveLength(1);
  });

  it('flags a dynamic import into the /legacy/ tree', async () => {
    expect(await lintFixture('src/new-code/imports-legacy-dynamic.ts')).toHaveLength(1);
  });

  it('flags a re-export from the /legacy/ tree', async () => {
    expect(await lintFixture('src/new-code/reexports-legacy.ts')).toHaveLength(1);
  });

  it('flags a star re-export from the /legacy/ tree', async () => {
    expect(
      await lintAtPath("export * from '../legacy/inner.js';\n", 'src/new-code/star.ts')
    ).toHaveLength(1);
  });

  it('flags a legacy subpath of a workspace package', async () => {
    expect(await lintAtPath("import '@hushbox/db/legacy';\n", 'src/new-code/pkg.ts')).toHaveLength(
      1
    );
  });

  it('allows a file inside the /legacy/ tree to import a corpus sibling', async () => {
    expect(await lintFixture('src/legacy/importer.ts')).toEqual([]);
  });

  it('allows clean imports of siblings, npm modules, and workspace packages', async () => {
    expect(await lintFixture('src/new-code/clean.ts')).toEqual([]);
  });

  it('allows specifiers that merely contain "legacy" as a name fragment', async () => {
    expect(
      await lintAtPath(
        "import './prelegacy.js';\nimport './not-legacy.js';\nimport './legacy_old.js';\nimport './legacy-adapters/adapter.js';\n",
        'src/new-code/m.ts'
      )
    ).toEqual([]);
  });

  it('applies repo-wide, not just to slice paths', async () => {
    expect(
      await lintAtPath("import '../legacy/inner.js';\n", 'apps/web/src/lib/anywhere.ts')
    ).toHaveLength(1);
  });
});
