import path from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import ownConfig, { createBaseConfig, devServicesConfig } from './eslint.config.js';
import { loadEslintExtensions } from './eslint-extensions/load-extensions.mjs';

describe('default export', () => {
  it('provides a non-empty flat config so `eslint .` lints this package', () => {
    // Without a default export ESLint silently runs this package with an
    // empty config — the one package vendoring the custom rules would be the
    // only one outside the lint gate.
    expect(Array.isArray(ownConfig)).toBe(true);
    expect(ownConfig.length).toBeGreaterThan(0);
  });
});

describe('createBaseConfig extension slot', () => {
  it('appends every eslint-extensions entry at the end of the config', async () => {
    const extensions = await loadEslintExtensions(new URL('eslint-extensions/', import.meta.url));
    const config = createBaseConfig(import.meta.dirname);

    expect(extensions.length).toBeGreaterThan(0);
    // Module-cache identity: the same entry objects must be present, in order,
    // as the tail of the composed config so extension rules win flat-config
    // rule-key replacement for the files they scope.
    expect(config.slice(-extensions.length)).toEqual(extensions);
  });
});

async function noConsoleFindings(filePath) {
  const linter = new ESLint({
    cwd: import.meta.dirname,
    overrideConfigFile: true,
    overrideConfig: [
      { files: ['**/*.ts'], rules: { 'no-console': ['error', { allow: ['warn', 'error'] }] } },
      ...devServicesConfig,
    ],
  });
  const [result] = await linter.lintText("console.log('x');\n", {
    filePath: path.join(import.meta.dirname, filePath),
  });
  return result.messages.filter((m) => m.ruleId === 'no-console');
}

describe('devServicesConfig no-console exemption', () => {
  // The exemption exists for the two dev-only service implementations that
  // intentionally log to console (the console email sender and the local
  // Helcim webhook mock) — never for whatever else sits under a services dir.
  it('exempts the console email sender', async () => {
    expect(await noConsoleFindings('src/services/email/console.ts')).toEqual([]);
  });

  it('exempts the Helcim mock webhook service', async () => {
    expect(await noConsoleFindings('src/services/helcim/mock-webhook.ts')).toEqual([]);
  });

  it('keeps no-console on for every other file under a services dir', async () => {
    expect(await noConsoleFindings('src/services/ai/mock.ts')).toHaveLength(1);
  });
});
