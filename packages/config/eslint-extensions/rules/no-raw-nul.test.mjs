// Programmatic ESLint tests for the vendored no-raw-nul rule.
// Deliberately independent of the eslint-extensions loader (same pattern as
// the other rule suites): the extension config is applied directly to fixture
// code, so these tests stay valid regardless of loader behavior.
//
// Every fixture is INLINE and builds its NUL with String.fromCodePoint(0).
// A fixture FILE carrying a raw NUL would be flagged by the very rule under
// test, and would itself be invisible to grep — the defect this rule exists to
// prevent.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import extensionConfig from '../no-raw-nul.config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const NUL = String.fromCodePoint(0);

function createLinter() {
  return new ESLint({
    cwd: here,
    overrideConfigFile: true,
    overrideConfig: [
      { files: ['**/*.ts'], languageOptions: { parser: tseslint.parser } },
      ...extensionConfig,
    ],
  });
}

async function lintAtPath(code, filePath) {
  const linter = createLinter();
  const [result] = await linter.lintText(code, {
    filePath: path.join(here, ...filePath.split('/')),
  });
  return result.messages.filter((m) => m.ruleId === 'text/no-raw-nul');
}

describe('no-raw-nul', () => {
  it('flags a raw NUL inside a string literal', async () => {
    expect(await lintAtPath(`const sep = '${NUL}';\n`, 'sample.ts')).toHaveLength(1);
  });

  it('allows the escaped spelling of the same character', async () => {
    expect(await lintAtPath("const sep = '\\u0000';\n", 'sample.ts')).toEqual([]);
  });

  it('flags a raw NUL outside any string literal', async () => {
    expect(await lintAtPath(`// separator${NUL}\nconst a = 1;\n`, 'sample.ts')).toHaveLength(1);
  });

  it('reports every raw NUL in the file, not only the first', async () => {
    expect(
      await lintAtPath(`const a = '${NUL}';\nconst b = '${NUL}';\n`, 'sample.ts')
    ).toHaveLength(2);
  });

  it('reports at the position of the offending byte', async () => {
    const [message] = await lintAtPath(`const a = 1;\nconst sep = '${NUL}';\n`, 'sample.ts');
    expect(message.line).toBe(2);
    expect(message.column).toBe(14);
  });

  it('applies repo-wide, not just to one package tree', async () => {
    expect(
      await lintAtPath(`const sep = '${NUL}';\n`, 'apps/web/src/lib/anywhere.ts')
    ).toHaveLength(1);
  });

  it('leaves a file with no NUL alone', async () => {
    expect(await lintAtPath("const sep = ' ';\n", 'sample.ts')).toEqual([]);
  });
});
