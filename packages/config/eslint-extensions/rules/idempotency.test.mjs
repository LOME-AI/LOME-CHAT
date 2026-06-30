// Programmatic ESLint tests for the vendored idempotency brand-cast ban.
// Deliberately independent of the eslint-extensions loader: the extension
// config is applied directly to fixture code, so these tests stay valid
// regardless of loader behavior.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import extensionConfig from '../idempotency.config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, '__test-fixtures-idempotency__');

// Fixture runs override only the rule's filename-scope option (the fixtures
// don't live under apps/api), keeping the extension's plugin wiring and
// severity intact. The rule is purely syntactic — no type services needed.
function createFixtureLinter(overrides = {}) {
  return new ESLint({
    cwd: fixturesDir,
    overrideConfigFile: true,
    overrideConfig: [
      ...extensionConfig,
      {
        files: ['**/*.ts'],
        languageOptions: { parser: tseslint.parser },
        rules: {
          'idempotency/no-brand-cast': ['error', { allowedFiles: 'brands-allowed', ...overrides }],
        },
      },
    ],
  });
}

async function lintFixture(file, overrides) {
  const linter = createFixtureLinter(overrides);
  const results = await linter.lintFiles([path.join(fixturesDir, file)]);
  return results[0].messages;
}

describe('no-brand-cast', () => {
  it('flags every `as Idempotent` / `as SettlementTx` cast, nested generics included', async () => {
    const messages = await lintFixture('casts-banned.ts');
    const findings = messages.filter((m) => m.ruleId === 'idempotency/no-brand-cast');
    // One per cast in the fixture: direct Idempotent, direct SettlementTx,
    // brand nested in a generic, the `as unknown as` laundering form, and the
    // angle-bracket assertion (`<SettlementTx>{}`).
    expect(findings).toHaveLength(5);
    expect(findings.map((m) => m.line)).toEqual([5, 6, 7, 8, 9]);
  });

  it('accepts ordinary casts and annotations', async () => {
    const messages = await lintFixture('clean.ts');
    expect(messages.filter((m) => m.ruleId === 'idempotency/no-brand-cast')).toEqual([]);
  });

  it('allows the casts inside the brand-minting module', async () => {
    const messages = await lintFixture('brands-allowed/brands.ts');
    expect(messages).toEqual([]);
  });

  it('defaults its allowed path to the idempotency brands module', async () => {
    const linter = new ESLint({
      cwd: fixturesDir,
      overrideConfigFile: true,
      overrideConfig: [
        ...extensionConfig,
        { files: ['**/*.ts'], languageOptions: { parser: tseslint.parser } },
      ],
    });
    const code = 'export const x = {} as SettlementTx;\ntype SettlementTx = { readonly b: 1 };\n';
    const outside = path.join(fixturesDir, 'apps', 'api', 'src', 'slices', 'billing', 'settle.ts');
    const inside = path.join(fixturesDir, 'apps', 'api', 'src', 'lib', 'idempotency', 'brands.ts');

    const [outsideResult] = await linter.lintText(code, { filePath: outside });
    const [insideResult] = await linter.lintText(code, { filePath: inside });

    expect(
      outsideResult.messages.filter((m) => m.ruleId === 'idempotency/no-brand-cast')
    ).toHaveLength(1);
    expect(insideResult.messages).toEqual([]);
  });
});

describe('no-brand-import', () => {
  // Virtual file paths under the fixtures dir mirror the real tree so the
  // rule's absolute-filename self-scoping is exercised as shipped.
  const sliceDomainFile = path.join(
    fixturesDir,
    'apps',
    'api',
    'src',
    'slices',
    'billing',
    'domain',
    'settle.ts'
  );
  const internalFile = path.join(
    fixturesDir,
    'apps',
    'api',
    'src',
    'lib',
    'idempotency',
    'by-key.ts'
  );

  async function lintVirtual(code, filePath) {
    const linter = new ESLint({
      cwd: fixturesDir,
      overrideConfigFile: true,
      overrideConfig: [
        ...extensionConfig,
        { files: ['**/*.ts'], languageOptions: { parser: tseslint.parser } },
      ],
    });
    const [result] = await linter.lintText(code, { filePath });
    return result.messages.filter((m) => m.ruleId === 'idempotency/no-brand-import');
  }

  it('flags a slice domain file deep-importing a brand constructor', async () => {
    // Without this rule the deep import lints clean — no other rule guards
    // the brands module, so this test pins the only enforcement.
    const findings = await lintVirtual(
      "import { brandSettlementTx } from '../../../lib/idempotency/brands.js';\nexport const forge = brandSettlementTx;\n",
      sliceDomainFile
    );
    expect(findings).toHaveLength(1);
  });

  it('flags an extensionless deep import of the brands module', async () => {
    const findings = await lintVirtual(
      "import { brandIdempotent } from '../../../lib/idempotency/brands';\nexport const forge = brandIdempotent;\n",
      sliceDomainFile
    );
    expect(findings).toHaveLength(1);
  });

  it('flags a type-only deep import of the brands module', async () => {
    const findings = await lintVirtual(
      "import type { SettlementTx } from '../../../lib/idempotency/brands.js';\nexport type T = SettlementTx;\n",
      sliceDomainFile
    );
    expect(findings).toHaveLength(1);
  });

  it('flags dynamic-import and re-export forms', async () => {
    const findings = await lintVirtual(
      "export { brandIdempotent } from '../../../lib/idempotency/brands.js';\nexport * from '../../../lib/idempotency/brands.js';\nexport const lazy = import('../../../lib/idempotency/brands.js');\n",
      sliceDomainFile
    );
    expect(findings).toHaveLength(3);
  });

  it('allows the idempotency module itself to import its brands', async () => {
    const findings = await lintVirtual(
      "import { brandIdempotent } from './brands.js';\nexport const mint = brandIdempotent;\n",
      internalFile
    );
    expect(findings).toEqual([]);
  });

  it('allows importing the idempotency barrel from a slice', async () => {
    const findings = await lintVirtual(
      "import { idempotent } from '../../../lib/idempotency/index.js';\nexport const use = idempotent;\n",
      sliceDomainFile
    );
    expect(findings).toEqual([]);
  });

  it('ignores package specifiers — only relative paths can resolve to the module', async () => {
    const findings = await lintVirtual(
      "import { idempotent } from '@hushbox/api-lib';\nexport const use = idempotent;\n",
      sliceDomainFile
    );
    expect(findings).toEqual([]);
  });

  it('allows an unrelated module that happens to be named brands', async () => {
    const findings = await lintVirtual(
      "import { brands } from './brands.js';\nexport const all = brands;\n",
      sliceDomainFile
    );
    expect(findings).toEqual([]);
  });
});
