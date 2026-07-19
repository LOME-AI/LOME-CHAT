// Programmatic ESLint tests for the vendored no-external-sentry rule.
// Applies the extension config directly to inline code (no loader, no fixture
// tree) so the test stays valid regardless of loader behavior. The rule needs
// no type information, so a bare tseslint parser (syntax only) is enough.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import extensionConfig from '../no-external-sentry.config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
// Repo root, derived from this file's location, so the default allowed-path
// regex (apps/api/src/lib/telemetry/adapters) matches the synthetic file paths.
const repoRoot = path.resolve(here, '..', '..', '..', '..');

const outsidePath = path.join(repoRoot, 'apps', 'api', 'src', 'slices', 'chat', 'turn.ts');
const insidePath = path.join(
  repoRoot,
  'apps',
  'api',
  'src',
  'lib',
  'telemetry',
  'adapters',
  'sentry-adapter.ts'
);

function createLinter() {
  return new ESLint({
    cwd: repoRoot,
    overrideConfigFile: true,
    overrideConfig: [
      ...extensionConfig,
      { files: ['**/*.ts'], languageOptions: { parser: tseslint.parser } },
    ],
  });
}

async function lintAt(code, filePath) {
  const [result] = await createLinter().lintText(code, { filePath });
  return result.messages.filter((m) => m.ruleId === 'no-external-sentry/no-external-sentry');
}

describe('no-external-sentry', () => {
  it('flags every @sentry import form outside the telemetry adapter', async () => {
    // Static value import, static type import, star re-export, named re-export,
    // and dynamic import — every way a @sentry specifier can enter a module.
    const code = [
      "import * as S from '@sentry/cloudflare';",
      "import type { ErrorEvent } from '@sentry/node';",
      "export * from '@sentry/core';",
      "export { init } from '@sentry/cloudflare';",
      "export async function d() { return import('@sentry/cloudflare'); }",
      'export const x = S;',
    ].join('\n');
    const findings = await lintAt(code, outsidePath);
    expect(findings).toHaveLength(5);
  });

  it('allows @sentry imports inside the telemetry adapter directory', async () => {
    const code = [
      "import { CloudflareClient } from '@sentry/cloudflare';",
      "import type { ErrorEvent } from '@sentry/cloudflare';",
      'export const client = CloudflareClient;',
    ].join('\n');
    const findings = await lintAt(code, insidePath);
    expect(findings).toEqual([]);
  });

  it('leaves non-@sentry imports and source-less exports untouched', async () => {
    const code = [
      "import { retry } from 'cockatiel';",
      'const y = 1;',
      'export { y };',
      'export const z = retry;',
    ].join('\n');
    const findings = await lintAt(code, outsidePath);
    expect(findings).toEqual([]);
  });
});
