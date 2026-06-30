// Programmatic ESLint tests for the vendored runtime-primitives rules.
// Deliberately independent of the eslint-extensions loader: the extension
// config is applied directly to fixture code, so these tests stay valid
// regardless of loader behavior.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import extensionConfig from '../runtime-primitives.config.mjs';
import mustUseResult from './must-use-result.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, '__test-fixtures-runtime-primitives__');

// Fixture runs override only the rules' filename-scope options (the fixtures
// don't live under apps/api), keeping the extension's plugin wiring and
// severities intact.
function createFixtureLinter() {
  return new ESLint({
    cwd: fixturesDir,
    overrideConfigFile: true,
    overrideConfig: [
      ...extensionConfig,
      {
        files: ['**/*.ts'],
        languageOptions: {
          parser: tseslint.parser,
          parserOptions: { project: './tsconfig.json', tsconfigRootDir: fixturesDir },
        },
        rules: {
          'runtime-primitives/must-use-result': [
            'error',
            { files: '__test-fixtures-runtime-primitives__' },
          ],
          'runtime-primitives/no-external-cockatiel': [
            'error',
            { allowedFiles: 'inside-resilience' },
          ],
        },
      },
    ],
  });
}

async function lintFixture(file) {
  const linter = createFixtureLinter();
  const results = await linter.lintFiles([path.join(fixturesDir, file)]);
  return results[0].messages;
}

describe('must-use-result', () => {
  it('flags every discarded Result and ResultAsync', async () => {
    const messages = await lintFixture('result-invalid.ts');
    const findings = messages.filter((m) => m.ruleId === 'runtime-primitives/must-use-result');
    // One per discard in invalidCases(): bare call, awaited call, dropped
    // ResultAsync, a .map() chain whose final Result is dropped, a
    // void-wrapped call (`void` is not the escape hatch — an intentionally
    // ignored Result takes an explicit assignment or .match()), a Result in
    // either position of a comma expression that itself dead-ends, and a
    // dropped union type whose Ok arm makes it must-use.
    expect(findings).toHaveLength(8);
    expect(findings.map((m) => m.line)).toEqual([35, 36, 37, 38, 39, 40, 41, 42]);
  });

  it('accepts Results that are assigned, returned, matched, or passed on', async () => {
    const messages = await lintFixture('result-valid.ts');
    expect(messages.filter((m) => m.ruleId === 'runtime-primitives/must-use-result')).toEqual([]);
  });

  it('ignores files outside its scope without needing type information', async () => {
    const linter = new ESLint({
      cwd: fixturesDir,
      overrideConfigFile: true,
      overrideConfig: extensionConfig,
    });
    const [result] = await linter.lintText('foo();\n', {
      filePath: path.join(fixturesDir, 'apps', 'web', 'src', 'lib', 'out-of-scope.ts'),
    });
    expect(result.messages).toEqual([]);
  });

  it('fails loudly when an in-scope file lints without type services', async () => {
    // Espree-parsed run: parserServices has no program. A silent no-op here
    // would unguard the rule's whole scope, so it must throw instead.
    const linter = new ESLint({
      cwd: fixturesDir,
      overrideConfigFile: true,
      overrideConfig: [
        ...extensionConfig,
        {
          files: ['**/*.ts'],
          rules: {
            'runtime-primitives/must-use-result': ['error', { files: 'needs-types' }],
          },
        },
      ],
    });
    await expect(
      linter.lintText('doThing();\n', {
        filePath: path.join(fixturesDir, 'needs-types', 'file.ts'),
      })
    ).rejects.toThrow(/type-aware linting/);
  });

  it('treats a call with no enclosing statement as consumed', () => {
    // Defensive guard, unreachable through the ESLint API: the parser parents
    // every node up to Program, so the transparent-wrapper climb always ends
    // on a real ancestor before the chain runs out. Pin the guard by driving
    // the rule surface directly with a detached node.
    const reports = [];
    const listener = mustUseResult.create({
      options: [{ files: 'detached' }],
      filename: '/virtual/detached/file.ts',
      sourceCode: {
        parserServices: {
          program: { getTypeChecker: () => ({}) },
          esTreeNodeToTSNodeMap: new Map(),
        },
      },
      report: (descriptor) => reports.push(descriptor),
    });
    const call = { type: 'CallExpression', parent: { type: 'AwaitExpression', parent: null } };
    listener.CallExpression(call);
    expect(reports).toEqual([]);
  });
});

describe('no-external-cockatiel', () => {
  it('flags every cockatiel import form outside the factory', async () => {
    // Static import, dynamic import, named re-export, and star re-export.
    const messages = await lintFixture('cockatiel-outside.ts');
    const findings = messages.filter(
      (m) => m.ruleId === 'runtime-primitives/no-external-cockatiel'
    );
    expect(findings).toHaveLength(4);
  });

  it('allows cockatiel inside the policy factory', async () => {
    const messages = await lintFixture('inside-resilience/cockatiel-inside.ts');
    expect(messages).toEqual([]);
  });

  it('defaults its allowed path to apps/api/src/lib/resilience', async () => {
    const linter = new ESLint({
      cwd: fixturesDir,
      overrideConfigFile: true,
      overrideConfig: [
        ...extensionConfig,
        // must-use-result needs type services for in-scope files; this test
        // exercises only the cockatiel rule's default filename scoping.
        { files: ['**/*.ts'], rules: { 'runtime-primitives/must-use-result': 'off' } },
      ],
    });
    const code = "import { retry } from 'cockatiel';\nexport const x = retry;\n";
    const outside = path.join(fixturesDir, 'apps', 'api', 'src', 'slices', 'chat', 'turn.ts');
    const inside = path.join(fixturesDir, 'apps', 'api', 'src', 'lib', 'resilience', 'policies.ts');

    const [outsideResult] = await linter.lintText(code, { filePath: outside });
    const [insideResult] = await linter.lintText(code, { filePath: inside });

    expect(
      outsideResult.messages.filter((m) => m.ruleId === 'runtime-primitives/no-external-cockatiel')
    ).toHaveLength(1);
    expect(insideResult.messages).toEqual([]);
  });
});
