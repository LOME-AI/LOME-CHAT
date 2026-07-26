// Programmatic ESLint tests for the vendored fee-seams rule.
// Deliberately independent of the eslint-extensions loader (same pattern as
// the other rule suites): the extension config is applied directly to
// synthetic code at synthetic repo paths, so these tests stay valid
// regardless of loader behavior and of the live tree's lint state.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import extensionConfig, { FEE_APPLICATION_SEAMS } from '../fee-seams.config.mjs';

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

async function lintAtPath(code, repoRelativePath) {
  const linter = createLinter();
  const [result] = await linter.lintText(code, {
    filePath: path.join(here, ...repoRelativePath.split('/')),
  });
  return result.messages.filter((m) => m.ruleId === 'money/fee-seams');
}

describe('fee-seams', () => {
  it('flags an applyMarkupCeil import outside the sanctioned seams', async () => {
    expect(
      await lintAtPath(
        "import { applyMarkupCeil } from '@hushbox/shared';\n",
        'apps/api/src/slices/chat/domain/turn-definition.ts'
      )
    ).toHaveLength(1);
  });

  it('flags an applyMarkup import regardless of local alias', async () => {
    expect(
      await lintAtPath(
        "import { applyMarkup as bake } from '@hushbox/shared';\n",
        'apps/web/src/hooks/billing/use-prompt-budget.ts'
      )
    ).toHaveLength(1);
  });

  it('flags a fee-helper import from any module path, not only the shared barrel', async () => {
    expect(
      await lintAtPath(
        "import { applyMarkup } from './money.js';\n",
        'apps/api/src/slices/billing/domain/charge.ts'
      )
    ).toHaveLength(1);
  });

  it('flags a future fee helper matching the applyMarkup* name pattern', async () => {
    expect(
      await lintAtPath(
        "import { applyMarkupFloor } from '@hushbox/shared';\n",
        'apps/api/src/slices/chat/domain/anything.ts'
      )
    ).toHaveLength(1);
  });

  it('flags a named re-export that launders a fee helper outward', async () => {
    expect(
      await lintAtPath(
        "export { applyMarkupCeil } from '@hushbox/shared';\n",
        'apps/api/src/slices/chat/index.ts'
      )
    ).toHaveLength(1);
  });

  it('flags a renaming re-export (matching is on the source-side name)', async () => {
    expect(
      await lintAtPath(
        "export { applyMarkup as bakeFee } from '@hushbox/shared';\n",
        'packages/crypto/src/index.ts'
      )
    ).toHaveLength(1);
  });

  it('flags a star re-export of a money module outside the seams', async () => {
    expect(
      await lintAtPath(
        "export * from '../money.js';\n",
        'packages/shared/src/affordability/estimate/index.ts'
      )
    ).toHaveLength(1);
  });

  it('reports one violation per matching specifier', async () => {
    expect(
      await lintAtPath(
        "import { applyMarkup, applyMarkupCeil, usdToNanoUsd } from '@hushbox/shared';\n",
        'apps/api/src/slices/chat/domain/pricing.ts'
      )
    ).toHaveLength(2);
  });

  it('allows every sanctioned seam site to import the fee helpers', async () => {
    for (const seam of FEE_APPLICATION_SEAMS) {
      expect(
        await lintAtPath("import { applyMarkup, applyMarkupCeil } from '@hushbox/shared';\n", seam)
      ).toEqual([]);
    }
  });

  it('allows the shared barrel to publish the helpers via named re-export', async () => {
    expect(
      await lintAtPath(
        "export { applyMarkup, applyMarkupCeil } from './money.js';\n",
        'packages/shared/src/index.ts'
      )
    ).toEqual([]);
  });

  it('allows test files to import the helpers for expected-value math', async () => {
    expect(
      await lintAtPath(
        "import { applyMarkupCeil } from '@hushbox/shared';\n",
        'apps/api/src/slices/chat/domain/settlement.integration.test.ts'
      )
    ).toEqual([]);
  });

  it('allows unrelated imports from the shared barrel', async () => {
    expect(
      await lintAtPath(
        "import { usdToNanoUsd, roundHalfEvenDiv } from '@hushbox/shared';\n",
        'apps/api/src/slices/chat/domain/anything.ts'
      )
    ).toEqual([]);
  });

  it('allows star re-exports of non-money modules', async () => {
    expect(
      await lintAtPath("export * from './types.js';\n", 'apps/api/src/slices/chat/index.ts')
    ).toEqual([]);
  });

  it('flags a string-literal import name (ES2022 arbitrary module namespace names)', async () => {
    expect(
      await lintAtPath(
        "import { 'applyMarkupCeil' as bake } from '@hushbox/shared';\n",
        'apps/api/src/slices/chat/domain/anything.ts'
      )
    ).toHaveLength(1);
  });

  it('flags a fee helper reached through a namespace import', async () => {
    expect(
      await lintAtPath(
        "import * as shared from '@hushbox/shared';\nexport const rate = shared.applyMarkupCeil(1n);\n",
        'apps/api/src/slices/chat/domain/turn-context.ts'
      )
    ).toHaveLength(1);
  });

  it('flags a fee helper reached through a default module-object import', async () => {
    expect(
      await lintAtPath(
        "import shared from '@hushbox/shared';\nexport const rate = shared.applyMarkup(1n, 15);\n",
        'apps/web/src/hooks/billing/use-prompt-budget.ts'
      )
    ).toHaveLength(1);
  });

  it('flags a string-literal fee-helper access on a namespace import', async () => {
    expect(
      await lintAtPath(
        "import * as shared from '@hushbox/shared';\nexport const rate = shared['applyMarkupCeil'](1n);\n",
        'apps/api/src/slices/chat/domain/anything.ts'
      )
    ).toHaveLength(1);
  });

  it('allows a namespace fee-helper call at every sanctioned seam', async () => {
    for (const seam of FEE_APPLICATION_SEAMS) {
      expect(
        await lintAtPath(
          "import * as shared from '@hushbox/shared';\nexport const rate = shared.applyMarkupCeil(1n);\n",
          seam
        )
      ).toEqual([]);
    }
  });

  it('ignores a fully dynamic namespace member access', async () => {
    expect(
      await lintAtPath(
        "import * as shared from '@hushbox/shared';\nexport const pick = (key: string): unknown => shared[key as keyof typeof shared];\n",
        'apps/api/src/slices/chat/domain/anything.ts'
      )
    ).toEqual([]);
  });

  it('ignores a dynamic import() module-object binding (documented limitation)', async () => {
    expect(
      await lintAtPath(
        "export const rate = async (): Promise<bigint> => {\n  const m = await import('@hushbox/shared');\n  return m.applyMarkupCeil(1n);\n};\n",
        'apps/api/src/slices/chat/domain/anything.ts'
      )
    ).toEqual([]);
  });

  it('ignores a fee-helper access on a binding that shadows the namespace import', async () => {
    expect(
      await lintAtPath(
        "import * as shared from '@hushbox/shared';\nexport const bake = (shared: { applyMarkupCeil: (n: bigint) => bigint }): bigint =>\n  shared.applyMarkupCeil(1n);\n",
        'apps/api/src/slices/chat/domain/anything.ts'
      )
    ).toEqual([]);
  });

  it('allows a bare module-object binding with no fee-helper access', async () => {
    expect(
      await lintAtPath(
        "import shared from '@hushbox/shared';\nimport * as money from '@hushbox/shared';\nexport { shared, money };\n",
        'apps/api/src/slices/chat/domain/anything.ts'
      )
    ).toEqual([]);
  });

  it('ignores local declarations that merely match the name pattern', async () => {
    expect(
      await lintAtPath(
        'const applyMarkupLocal = (n: bigint): bigint => n;\nexport { applyMarkupLocal };\n',
        'apps/api/src/slices/chat/domain/local.ts'
      )
    ).toEqual([]);
  });

  it('pins the seam list to exactly the sanctioned inventory', () => {
    expect(FEE_APPLICATION_SEAMS.toSorted()).toEqual(
      [
        'packages/shared/src/affordability/money.ts',
        'packages/shared/src/index.ts',
        'packages/shared/src/affordability/estimate/search-reservation.ts',
        'apps/api/src/slices/models/domain/normalize.ts',
        'apps/api/src/slices/billing/domain/money.ts',
        'scripts/lib/e2e-seeded-image-model.ts',
      ].toSorted()
    );
  });
});
