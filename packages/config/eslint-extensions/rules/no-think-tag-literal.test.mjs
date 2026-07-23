// Programmatic ESLint tests for the vendored no-think-tag-literal rule.
// Deliberately independent of the eslint-extensions loader (same pattern as
// the other rule suites): the extension config is applied directly to fixture
// code, so these tests stay valid regardless of loader behavior.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import extensionConfig from '../reasoning-format.config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

function createLinter() {
  return new ESLint({
    cwd: here,
    overrideConfigFile: true,
    overrideConfig: [
      { files: ['**/*.ts', '**/*.tsx'], languageOptions: { parser: tseslint.parser } },
      ...extensionConfig,
    ],
  });
}

async function lintAtPath(code, filePath) {
  const linter = createLinter();
  const [result] = await linter.lintText(code, {
    filePath: path.join(here, ...filePath.split('/')),
  });
  return result.messages.filter((m) => m.ruleId === 'reasoning-format/no-think-tag-literal');
}

describe('no-think-tag-literal', () => {
  it('flags a string literal containing the opening delimiter', async () => {
    expect(await lintAtPath("const s = '<think>';\n", 'apps/web/src/lib/anywhere.ts')).toHaveLength(
      1
    );
  });

  it('flags a string literal containing the closing delimiter', async () => {
    expect(
      await lintAtPath("const s = '</think>';\n", 'apps/api/src/slices/chat/domain/x.ts')
    ).toHaveLength(1);
  });

  it('flags a delimiter embedded inside a larger string (once per literal)', async () => {
    expect(
      await lintAtPath(
        "const s = 'prefix <think>thoughts</think> answer';\n",
        'packages/shared/src/anywhere.ts'
      )
    ).toHaveLength(1);
  });

  it('flags a template literal carrying a delimiter', async () => {
    expect(
      await lintAtPath('const s = `<think>${1}`;\n', 'apps/web/src/components/x.tsx')
    ).toHaveLength(1);
  });

  it('stays silent on the shared parser module and its test', async () => {
    expect(
      await lintAtPath("const s = '<think></think>';\n", 'packages/shared/src/reasoning-format.ts')
    ).toEqual([]);
    expect(
      await lintAtPath(
        "const s = '<think></think>';\n",
        'packages/shared/src/reasoning-format.test.ts'
      )
    ).toEqual([]);
  });

  it('does not exempt look-alike filenames elsewhere', async () => {
    expect(
      await lintAtPath("const s = '<think>';\n", 'apps/web/src/lib/reasoning-format.ts')
    ).toHaveLength(1);
  });

  it('allows strings that merely mention think without the delimiter', async () => {
    expect(
      await lintAtPath(
        "const a = 'think'; const b = 'thinking...'; const c = '<thinking>';\n",
        'apps/web/src/lib/clean.ts'
      )
    ).toEqual([]);
  });

  it('ignores comments (the ban is on string literals that could write the format)', async () => {
    expect(
      await lintAtPath(
        "// a raw value starting '<think>' resolves nowhere\nconst ok = 1;\n",
        'apps/api/src/slices/workflows/nodes/y.ts'
      )
    ).toEqual([]);
  });
});
