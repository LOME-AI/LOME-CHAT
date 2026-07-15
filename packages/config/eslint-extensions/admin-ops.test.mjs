// Programmatic ESLint tests for the admin op-body purity lint set. The
// config is applied directly to fixture code with synthetic paths, so the
// rule's absolute-filename self-scoping is exercised without real files.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import extensionConfig from './admin-ops.config.mjs';

const cwd = path.dirname(fileURLToPath(import.meta.url));

function createLinter() {
  return new ESLint({
    cwd,
    overrideConfigFile: true,
    overrideConfig: [
      { files: ['**/*.ts'], languageOptions: { parser: tseslint.parser } },
      ...extensionConfig,
    ],
  });
}

async function purityMessages(code, filePath) {
  const [result] = await createLinter().lintText(code, {
    filePath: path.join(cwd, ...filePath.split('/')),
  });
  return result.messages.filter((message) => message.ruleId === 'admin-ops/op-purity');
}

const OP_BODY = 'apps/api/src/slices/admin/domain/operations/wallet-credit.ts';
const OP_TEST = 'apps/api/src/slices/admin/domain/operations/wallet-credit.test.ts';
const ENGINE = 'apps/api/src/slices/admin/domain/engine.ts';
const BILLING = 'apps/api/src/slices/billing/domain/charge.ts';

describe('admin-ops/op-purity', () => {
  it('flags raw Date.now / Math.random / fetch in an op body', async () => {
    const code =
      "const a = Date.now();\nconst b = Math.random();\nawait fetch('https://x');\nconst c = globalThis.fetch;\nexport { a, b, c };\n";

    const messages = await purityMessages(code, OP_BODY);

    expect(messages.map((message) => message.messageId).toSorted()).toEqual([
      'dateNow',
      'fetch',
      'fetch',
      'mathRandom',
    ]);
  });

  it('flags infra and adapter value imports in an op body', async () => {
    const code =
      "import { eq } from 'drizzle-orm';\nimport { wallets } from '@hushbox/db';\nimport { createAdminStores } from '../../adapters/stores.js';\nexport { eq, wallets, createAdminStores };\n";

    const messages = await purityMessages(code, OP_BODY);

    expect(messages).toHaveLength(3);
    expect(messages.every((message) => message.messageId === 'valueImport')).toBe(true);
  });

  it('allows type-only imports and barrel composition in an op body', async () => {
    const code =
      "import type { Database } from '@hushbox/db';\nimport { chargeWithinTx } from '../../../billing/index.js';\nexport type Db = Database;\nexport { chargeWithinTx };\n";

    expect(await purityMessages(code, OP_BODY)).toEqual([]);
  });

  it('is silent in op tests, the engine, and other slices', async () => {
    const code = "const a = Date.now();\nawait fetch('https://x');\nexport { a };\n";

    expect(await purityMessages(code, OP_TEST)).toEqual([]);
    expect(await purityMessages(code, ENGINE)).toEqual([]);
    expect(await purityMessages(code, BILLING)).toEqual([]);
  });
});
