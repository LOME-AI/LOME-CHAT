import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { beforeAll, describe, expect, it } from 'vitest';
import viMockBanExtension from './vi-mock-ban.config.mjs';

const FIXTURES_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '__test-fixtures-vi-mock__'
);

let byFile;

beforeAll(async () => {
  const eslint = new ESLint({
    cwd: FIXTURES_ROOT,
    overrideConfigFile: true,
    overrideConfig: [
      { files: ['**/*.ts'], languageOptions: { parser: tseslint.parser } },
      ...viMockBanExtension,
    ],
  });
  const results = await eslint.lintFiles(['src/**/*.ts']);
  byFile = new Map();
  for (const result of results) {
    const relative = path.relative(FIXTURES_ROOT, result.filePath).replaceAll('\\', '/');
    byFile.set(relative, result.messages);
  }
});

function violations(file) {
  const messages = byFile.get(file);
  if (messages === undefined) {
    throw new Error(`fixture file was not linted: ${file}`);
  }
  return messages;
}

function restrictedSyntaxCount(file) {
  return violations(file).filter((message) => message.ruleId === 'no-restricted-syntax').length;
}

describe('vi.mock ban on internal-slice imports', () => {
  it('fails vi.mock of another slice barrel', () => {
    expect(
      restrictedSyntaxCount('src/slices/chat/domain/mocks-other-slice-barrel.test.ts')
    ).toBeGreaterThan(0);
  });

  it('fails vi.mock of another slice internal', () => {
    expect(
      restrictedSyntaxCount('src/slices/chat/domain/mocks-other-slice-internal.test.ts')
    ).toBeGreaterThan(0);
  });

  it('fails vi.mock of an own-slice internal module', () => {
    expect(
      restrictedSyntaxCount('src/slices/chat/domain/mocks-own-internal.test.ts')
    ).toBeGreaterThan(0);
  });

  it('fails vi.mock of a slice path written with an alias', () => {
    expect(
      restrictedSyntaxCount('src/slices/chat/domain/mocks-slice-by-alias.test.ts')
    ).toBeGreaterThan(0);
  });

  it('fails vi.mock of a slice from a lib test', () => {
    expect(restrictedSyntaxCount('src/lib/result/mocks-slice-from-lib.test.ts')).toBeGreaterThan(0);
  });

  it('fails vi.mock of a slice from a lib/context test', () => {
    expect(
      restrictedSyntaxCount('src/lib/context/mocks-slice-from-context.test.ts')
    ).toBeGreaterThan(0);
  });

  it('passes vi.mock of an external-seam adapter', () => {
    expect(
      restrictedSyntaxCount('src/slices/chat/domain/mocks-external-seam-adapter.test.ts')
    ).toBe(0);
  });

  it('passes vi.mock of an npm module from a slice test', () => {
    expect(restrictedSyntaxCount('src/slices/chat/domain/mocks-npm-module.test.ts')).toBe(0);
  });

  it('passes vi.mock of an npm module from a lib test', () => {
    expect(restrictedSyntaxCount('src/lib/result/mocks-npm-from-lib.test.ts')).toBe(0);
  });

  it('does not flag non-test slice source files', () => {
    expect(violations('src/slices/billing/domain/charge.ts')).toEqual([]);
  });
});
