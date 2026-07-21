import path from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import ownConfig, {
  createBaseConfig,
  devServicesConfig,
  e2eUniversalRestrictedSyntax,
} from './eslint.config.js';
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

// Tests the shared e2e selector array directly (the same list spread into both
// the helper-scoped and spec-scoped `no-restricted-syntax` blocks) so the rule
// is exercised without dragging the type-aware playwright plugins into the
// fixture lint.
async function idempotencyKeyFindings(code, filePath = 'e2e/helpers/sample.ts') {
  const linter = new ESLint({
    cwd: import.meta.dirname,
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ['**/*.ts'],
        rules: { 'no-restricted-syntax': ['error', ...e2eUniversalRestrictedSyntax] },
      },
    ],
  });
  const [result] = await linter.lintText(code, {
    filePath: path.join(import.meta.dirname, filePath),
  });
  return result.messages.filter(
    (m) => m.ruleId === 'no-restricted-syntax' && /Idempotency-Key/.test(m.message)
  );
}

describe('e2e hand-rolled Idempotency-Key ban', () => {
  // The single sanctioned way to attach an Idempotency-Key to a mutating e2e
  // request is the idempotent-request helper; hand-rolling a fresh key at a call
  // site is how the billing-token test drifted (a sibling call omitted it and
  // 400'd). This rule pins the class so the header discipline stays in one place.
  const handRolled =
    "async function f(request) { await request.post('/x', { headers: { 'Idempotency-Key': crypto.randomUUID() }, data: {} }); }";

  it('flags a hand-rolled crypto.randomUUID Idempotency-Key in a helper', async () => {
    expect(await idempotencyKeyFindings(handRolled)).toHaveLength(1);
  });

  it('flags a hand-rolled crypto.randomUUID Idempotency-Key in a spec', async () => {
    expect(await idempotencyKeyFindings(handRolled, 'e2e/x.spec.ts')).toHaveLength(1);
  });

  it('allows an intentional fixed-string Idempotency-Key (idempotent-replay tests)', async () => {
    const fixedKey =
      "async function f(request) { await request.post('/x', { headers: { 'Idempotency-Key': 'replay-key' }, data: {} }); }";
    expect(await idempotencyKeyFindings(fixedKey)).toHaveLength(0);
  });

  it('allows the idempotent-request wrapper call', async () => {
    const viaWrapper =
      "async function f(request) { await idempotentPost(request, '/x', { data: {} }); }";
    expect(await idempotencyKeyFindings(viaWrapper)).toHaveLength(0);
  });
});
