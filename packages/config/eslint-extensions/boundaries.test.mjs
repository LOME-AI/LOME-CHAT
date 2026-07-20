import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { beforeAll, describe, expect, it } from 'vitest';
import boundariesExtension from './boundaries.config.mjs';

const FIXTURES_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '__test-fixtures-boundaries__'
);

// Mirrors the apps/api shape: turbo runs each package's lint with the package
// dir as cwd, which is where cwd-relative element patterns break.
const PACKAGE_DIR = path.join(FIXTURES_ROOT, 'apps', 'api');

/**
 * Recreates the pnpm workspace-link shape (`node_modules/@fixture/shared` →
 * `../../../../packages/shared`) at test time: `node_modules/` is gitignored,
 * so a committed symlink would never survive a fresh checkout.
 */
async function ensureWorkspaceLink() {
  const linkDir = path.join(PACKAGE_DIR, 'node_modules', '@fixture');
  await fs.mkdir(linkDir, { recursive: true });
  try {
    await fs.symlink(
      path.join('..', '..', '..', '..', 'packages', 'shared'),
      path.join(linkDir, 'shared'),
      'dir'
    );
  } catch (error) {
    if (error.code !== 'EEXIST') {
      throw error;
    }
  }
}

function buildEslint(cwd) {
  return new ESLint({
    cwd,
    overrideConfigFile: true,
    overrideConfig: [
      { files: ['**/*.ts'], languageOptions: { parser: tseslint.parser } },
      ...boundariesExtension,
    ],
  });
}

async function lintTree(cwd, patterns) {
  const eslint = buildEslint(cwd);
  const results = await eslint.lintFiles(patterns);
  const byFile = new Map();
  for (const result of results) {
    const relative = path.relative(cwd, result.filePath).replaceAll('\\', '/');
    byFile.set(relative, result.messages);
  }
  return byFile;
}

/** Lints the whole fixture tree once from the fixtures root; tests assert per-file. */
function lintFixtures() {
  return lintTree(FIXTURES_ROOT, ['src/**/*.ts', 'apps/api/src/**/*.ts']);
}

/**
 * Lints the fixture package the way turbo does (`eslint .` with the package
 * dir as cwd). eslint-plugin-boundaries anchors element patterns to
 * `process.cwd()` unless `boundaries/root-path` is set, so the chdir — not
 * just the ESLint `cwd` option — is what reproduces the turbo invocation.
 */
async function lintFromPackageCwd() {
  const previousCwd = process.cwd();
  process.chdir(PACKAGE_DIR);
  try {
    return await lintTree(PACKAGE_DIR, ['src/**/*.ts']);
  } finally {
    process.chdir(previousCwd);
  }
}

let byFile;
let byFileFromPackageCwd;

beforeAll(async () => {
  await ensureWorkspaceLink();
  byFile = await lintFixtures();
  byFileFromPackageCwd = await lintFromPackageCwd();
});

function messagesFrom(map, file) {
  const messages = map.get(file);
  if (messages === undefined) {
    throw new Error(`fixture file was not linted: ${file}`);
  }
  return messages;
}

function violations(file) {
  return messagesFrom(byFile, file);
}

function ruleIds(file) {
  return violations(file).map((message) => message.ruleId);
}

function packageCwdViolations(file) {
  return messagesFrom(byFileFromPackageCwd, file);
}

function packageCwdRuleIds(file) {
  return packageCwdViolations(file).map((message) => message.ruleId);
}

describe('cross-slice boundaries', () => {
  it('fails a cross-slice import of another slice internal', () => {
    expect(ruleIds('src/slices/beta/domain/cross-slice-internal.ts')).toContain(
      'boundaries/dependencies'
    );
  });

  it('fails a cross-slice internal import written with a .js suffix', () => {
    expect(ruleIds('src/slices/beta/domain/cross-slice-internal-js.ts')).toContain(
      'boundaries/dependencies'
    );
  });

  it('passes a cross-slice import of another slice barrel', () => {
    expect(violations('src/slices/beta/domain/cross-slice-barrel.ts')).toEqual([]);
  });
});

describe('intra-slice layers', () => {
  it('fails domain importing its own slice adapters', () => {
    expect(ruleIds('src/slices/alpha/domain/imports-own-adapter.ts')).toContain(
      'boundaries/dependencies'
    );
  });

  it('fails domain importing an infra library', () => {
    expect(ruleIds('src/slices/alpha/domain/imports-infra.ts')).toContain(
      'boundaries/dependencies'
    );
  });

  it('fails routes importing domain internals', () => {
    expect(ruleIds('src/slices/gamma/routes.ts')).toContain('boundaries/dependencies');
  });

  it('passes routes importing the domain barrel and middleware', () => {
    expect(violations('src/slices/alpha/routes.ts')).toEqual([]);
  });

  it('passes domain importing its own ports', () => {
    expect(violations('src/slices/alpha/domain/service.ts')).toEqual([]);
  });

  it('passes domain importing a non-infra external library', () => {
    expect(violations('src/slices/alpha/domain/imports-zod.ts')).toEqual([]);
  });

  it('passes adapters importing an infra library', () => {
    expect(violations('src/slices/alpha/adapters/imports-infra.ts')).toEqual([]);
  });

  it('passes the slice barrel re-exporting its own internals', () => {
    expect(violations('src/slices/alpha/index.ts')).toEqual([]);
  });
});

describe('out-of-tree isolation', () => {
  it('fails domain importing a file outside the backend trees', () => {
    expect(ruleIds('src/slices/alpha/domain/imports-out-of-tree.ts')).toContain(
      'boundaries/dependencies'
    );
  });

  it('passes domain importing a lib module', () => {
    expect(violations('src/slices/alpha/domain/imports-lib.ts')).toEqual([]);
  });

  it('fails a lib module importing a slice', () => {
    expect(ruleIds('src/lib/result/imports-slice.ts')).toContain('boundaries/dependencies');
  });

  it('passes a lib module importing another lib module', () => {
    expect(violations('src/lib/errors/uses-result.ts')).toEqual([]);
  });

  it('passes a middleware module with no foreign imports', () => {
    expect(violations('src/middleware/pipeline-example.ts')).toEqual([]);
  });

  it('fails middleware importing a slice internal', () => {
    expect(ruleIds('src/middleware/imports-slice-internal.ts')).toContain(
      'boundaries/dependencies'
    );
  });
});

describe('workspace package imports', () => {
  it('passes a ports file importing a workspace package from the fixtures root', () => {
    expect(violations('apps/api/src/slices/delta/ports/imports-workspace-package.ts')).toEqual([]);
  });

  it('fails a cross-slice internal import from the fixtures root', () => {
    expect(ruleIds('apps/api/src/slices/epsilon/domain/cross-slice-internal.ts')).toContain(
      'boundaries/dependencies'
    );
  });

  it('passes a ports file importing a workspace package from the package cwd', () => {
    expect(packageCwdViolations('src/slices/delta/ports/imports-workspace-package.ts')).toEqual([]);
  });

  it('passes a lib file importing a workspace package from the package cwd', () => {
    expect(packageCwdViolations('src/lib/context/imports-workspace-package.ts')).toEqual([]);
  });

  it('fails a cross-slice internal import from the package cwd', () => {
    expect(packageCwdRuleIds('src/slices/epsilon/domain/cross-slice-internal.ts')).toContain(
      'boundaries/dependencies'
    );
  });
});
