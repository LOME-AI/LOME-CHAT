// Programmatic ESLint tests for the engine/node purity lint set. The config
// is applied directly to fixture code at synthetic paths, so the rules'
// absolute-filename self-scoping is exercised without real files.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import extensionConfig from './engine-purity.config.mjs';

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
  return result.messages.filter((m) => m.ruleId === 'engine-purity/engine-node-purity');
}

async function registryMessages(code, filePath) {
  const [result] = await createLinter().lintText(code, {
    filePath: path.join(cwd, ...filePath.split('/')),
  });
  return result.messages.filter((m) => m.ruleId === 'engine-purity/capability-registry-only');
}

const ENGINE = 'apps/api/src/slices/workflows/engine/interpreter.ts';
const NODE = 'apps/api/src/slices/workflows/nodes/model-call-execution.ts';
const BILLING = 'apps/api/src/slices/billing/domain/charge.ts';
const REGISTRY = 'apps/api/src/slices/workflows/engine/live-execution-registry.ts';

describe('engine-node-purity', () => {
  it('flags raw Date.now / Math.random / fetch in engine code', async () => {
    const code = 'const a = Date.now();\nconst b = Math.random();\nfetch("/x");\n';
    expect(await purityMessages(code, ENGINE)).toHaveLength(3);
  });

  it('flags the same raw globals in node code', async () => {
    expect(await purityMessages('const a = Date.now();\n', NODE)).toHaveLength(1);
  });

  it('flags global-rooted forms: globalThis.Date.now, window.Math.random, self.fetch, window.fetch', async () => {
    const code =
      'globalThis.Date.now();\nwindow.Math.random();\nself.fetch("/x");\nwindow.fetch("/y");\n';
    expect(await purityMessages(code, ENGINE)).toHaveLength(4);
  });

  it('does NOT flag other slices — the raw globals are legal in billing', async () => {
    const code = 'const a = Date.now();\nconst b = Math.random();\nfetch("/x");\n';
    expect(await purityMessages(code, BILLING)).toEqual([]);
  });

  it('flags a node runtime import of a cross-slice barrel', async () => {
    const code = "import { chargeWithinTx } from '../../billing/index.js';\n";
    expect(await purityMessages(code, NODE)).toHaveLength(1);
  });

  it('flags a node runtime import of @hushbox/db', async () => {
    expect(await purityMessages("import { sql } from '@hushbox/db';\n", NODE)).toHaveLength(1);
  });

  it('allows a type-only barrel import in node code', async () => {
    const code = "import type { ModelProvider } from '../../models/index.js';\n";
    expect(await purityMessages(code, NODE)).toEqual([]);
  });

  it('does not restrict barrel value imports in engine (non-node) code', async () => {
    const code = "import { chargeWithinTx } from '../../billing/index.js';\n";
    expect(await purityMessages(code, REGISTRY)).toEqual([]);
  });
});

describe('capability-registry-only', () => {
  it('flags an interpreter importing a capability node execution directly', async () => {
    const code = "import { createModelCallExecution } from '../nodes/model-call-execution.js';\n";
    expect(await registryMessages(code, ENGINE)).toHaveLength(1);
  });

  it('allows the registry to import capability node executions', async () => {
    const code = "import { createModelCallExecution } from '../nodes/model-call-execution.js';\n";
    expect(await registryMessages(code, REGISTRY)).toEqual([]);
  });

  it('allows a type-only re-export of a capability type', async () => {
    const code = "export type { ModelBinding } from '../nodes/model-call-execution.js';\n";
    expect(await registryMessages(code, ENGINE)).toEqual([]);
  });
});
