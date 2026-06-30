// Programmatic ESLint tests for the vendored redaction rules. Deliberately
// independent of the eslint-extensions loader (same pattern as the
// runtime-primitives tests): the extension config is applied directly to
// fixture code, so these tests stay valid regardless of loader behavior.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import extensionConfig from '../redaction.config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, '__test-fixtures-redaction__');

// Fixture runs override only the rules' filename-scope options (the fixtures
// don't live under apps/api), keeping plugin wiring and severities intact.
// No `project` is needed: all three rules are purely syntactic.
function createFixtureLinter() {
  return new ESLint({
    cwd: fixturesDir,
    overrideConfigFile: true,
    overrideConfig: [
      ...extensionConfig,
      {
        files: ['**/*.ts'],
        languageOptions: { parser: tseslint.parser },
        rules: {
          'redaction/no-raw-console': [
            'error',
            {
              files: '__test-fixtures-redaction__',
              allowedFiles: String.raw`adapter-allowed/console-adapter\.ts$`,
            },
          ],
          'redaction/no-sensitive-log-argument': [
            'error',
            { files: '__test-fixtures-redaction__' },
          ],
          'redaction/logger-msg-literal': ['error', { files: '__test-fixtures-redaction__' }],
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

// Default-scope runs exercise the rules' built-in absolute-path scoping with
// synthetic apps/api paths; snippets are plain JS so the default parser works.
// Only rule-attributed messages are returned: a path no config entry matches
// (e.g. the test-file exclusion) yields ESLint's "file ignored" warning,
// which is exactly the silence these tests assert.
async function lintAtPath(code, filePath) {
  const linter = new ESLint({
    cwd: fixturesDir,
    overrideConfigFile: true,
    overrideConfig: extensionConfig,
  });
  const [result] = await linter.lintText(code, {
    filePath: path.join(fixturesDir, ...filePath.split('/')),
  });
  return result.messages.filter((message) => message.ruleId !== null);
}

describe('no-raw-console', () => {
  it('flags every console call: bare-literal as banned, non-literal as interpolation', async () => {
    const messages = await lintFixture('console-violations.ts');
    const findings = messages.filter((m) => m.ruleId === 'redaction/no-raw-console');
    expect(findings.map((m) => [m.line, m.messageId])).toEqual([
      [7, 'banned'],
      [8, 'interpolation'],
      [9, 'interpolation'],
      [10, 'interpolation'],
      [11, 'banned'],
      [12, 'banned'],
      [13, 'interpolation'],
    ]);
  });

  it('flags globalThis.console chains in default scope', async () => {
    const messages = await lintAtPath(
      "globalThis.console.log('x');\n",
      'apps/api/src/slices/chat/turn.ts'
    );
    expect(messages.map((m) => m.ruleId)).toContain('redaction/no-raw-console');
  });

  it('flags self.console chains with exactly one finding', async () => {
    // self.console is realistic in Workers and is the same sink as bare
    // console. logger-msg-literal skips every *.console receiver as this
    // rule's domain, so this rule must match the same set — otherwise the
    // call escapes both rules.
    const messages = await lintAtPath(
      'self.console.error(dynamicMsg);\n',
      'apps/api/src/slices/chat/turn.ts'
    );
    expect(messages.map((m) => [m.ruleId, m.messageId])).toEqual([
      ['redaction/no-raw-console', 'interpolation'],
    ]);
  });

  it('allows the telemetry console adapter file to call console', async () => {
    const messages = await lintFixture('adapter-allowed/console-adapter.ts');
    expect(messages).toEqual([]);
  });

  it('defaults its scope to the backend perimeter with the adapter exempt', async () => {
    const code = "console.log('x');\n";
    const inSlices = await lintAtPath(code, 'apps/api/src/slices/chat/turn.ts');
    const inMiddleware = await lintAtPath(code, 'apps/api/src/middleware/request-log.ts');
    const inApp = await lintAtPath(code, 'apps/api/src/app.ts');
    const inAdapter = await lintAtPath(code, 'apps/api/src/lib/telemetry/console-adapter.ts');
    const outsidePerimeter = await lintAtPath(code, 'apps/api/src/routes/health.ts');

    expect(inSlices.map((m) => m.ruleId)).toContain('redaction/no-raw-console');
    expect(inMiddleware.map((m) => m.ruleId)).toContain('redaction/no-raw-console');
    expect(inApp.map((m) => m.ruleId)).toContain('redaction/no-raw-console');
    expect(inAdapter).toEqual([]);
    expect(outsidePerimeter).toEqual([]);
  });

  it('fires by default in packages/realtime sources', async () => {
    const messages = await lintAtPath(
      "console.log('x');\n",
      'packages/realtime/src/conversation-room.ts'
    );
    expect(messages.map((m) => m.ruleId)).toContain('redaction/no-raw-console');
  });

  it('skips legacy-named files inside the perimeter', async () => {
    const code = "console.log('x');\n";
    expect(await lintAtPath(code, 'apps/api/src/lib/legacy_compat.ts')).toEqual([]);
    expect(await lintAtPath(code, 'packages/realtime/src/legacy_room.ts')).toEqual([]);
    expect(await lintAtPath(code, 'packages/realtime/src/legacy-rooms/room.ts')).toEqual([]);
  });
});

describe('no-sensitive-log-argument', () => {
  it('flags every sensitively-named expression logged through a logger call', async () => {
    const messages = await lintFixture('sensitive-args.ts');
    const findings = messages.filter((m) => m.ruleId === 'redaction/no-sensitive-log-argument');
    // One finding per statement line — each AST shape in the fixture
    // (identifier, member, object key, spread, array, call/new/await/unary,
    // conditional, optional chain, TS wrappers, shorthand key, private-in)
    // yields exactly one report. The shorthand line (52) pins the dedup
    // guard: key and value are the same node, so a double walk would report
    // it twice.
    expect(findings.map((m) => m.line)).toEqual([
      32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 60,
    ]);
  });

  it('fires in default scope for a sensitively-named variable', async () => {
    const messages = await lintAtPath(
      "logger.info('saved', message);\n",
      'apps/api/src/lib/context/middleware.ts'
    );
    expect(messages.map((m) => m.ruleId)).toContain('redaction/no-sensitive-log-argument');
  });
});

describe('logger-msg-literal', () => {
  it('flags every non-literal first argument to a logger-shaped call', async () => {
    const messages = await lintFixture('msg-literal.ts');
    const findings = messages.filter((m) => m.ruleId === 'redaction/logger-msg-literal');
    expect(findings.map((m) => m.line)).toEqual([12, 13, 14, 15]);
  });

  it('fires in default scope for a dynamic message', async () => {
    const messages = await lintAtPath(
      'logger.info(dynamicMsg);\n',
      'apps/api/src/slices/chat/domain/turn.ts'
    );
    expect(messages.map((m) => m.ruleId)).toContain('redaction/logger-msg-literal');
  });

  it('flags a mixed-template errorCode passed to captureError', async () => {
    // The one syntactic form that smuggles past the LiteralErrorCode type:
    // template-pattern inference accepts `code_${string}`, and that
    // caller-controlled string would flow into Sentry tags and fingerprints.
    const messages = await lintAtPath(
      'telemetry.captureError(err, `code_${reason}`);\n',
      'apps/api/src/slices/chat/domain/turn.ts'
    );
    expect(messages.map((m) => m.ruleId)).toEqual(['redaction/logger-msg-literal']);
  });

  it('allows a plain-literal errorCode passed to captureError', async () => {
    const messages = await lintAtPath(
      "telemetry.captureError(err, 'job_dead_letter');\n",
      'apps/api/src/slices/chat/domain/turn.ts'
    );
    expect(messages).toEqual([]);
  });

  it('allows an ERROR_CODES member-expression errorCode passed to captureError', async () => {
    // Real call shape (constant reference); the type level polices its
    // literal-ness — the syntactic rule must not flag it.
    const messages = await lintAtPath(
      'logger.captureError(error, ERROR_CODES.INTERNAL);\n',
      'apps/api/src/app.ts'
    );
    expect(messages).toEqual([]);
  });

  it('leaves globalThis.console calls to no-raw-console alone', async () => {
    // Console receivers are no-raw-console's domain; a second finding from
    // this rule on the same call is pure noise.
    const messages = await lintAtPath(
      'globalThis.console.error(dynamicMsg);\n',
      'apps/api/src/slices/chat/domain/turn.ts'
    );
    expect(messages.map((m) => m.ruleId)).toEqual(['redaction/no-raw-console']);
  });
});

describe('redaction rules on legitimate code', () => {
  it('stays silent on literal messages with allowlisted fields', async () => {
    const messages = await lintFixture('valid-logging.ts');
    expect(messages).toEqual([]);
  });

  it('stays silent outside the backend perimeter', async () => {
    const messages = await lintAtPath(
      'console.log(secret); logger.info(message);\n',
      'apps/web/src/lib/out-of-scope.ts'
    );
    expect(messages).toEqual([]);
  });

  it('stays silent in test files, where type-level rejection fixtures live', async () => {
    const messages = await lintAtPath(
      'logger.info(dynamicMsg);\n',
      'apps/api/src/lib/telemetry/console-adapter.test.ts'
    );
    expect(messages).toEqual([]);
  });
});

describe('redaction.config.mjs', () => {
  it('turns base no-console off for the one real adapter file, repo-root anchored', () => {
    // The base config allows only console.warn/error; the adapter maps log
    // levels onto console.debug/info too, so without this targeted override
    // the designated console caller could not lint clean. The entry is
    // anchored at the repo root via basePath so a lookalike path in another
    // package can never match the exemption.
    const entry = extensionConfig.find(
      (config) => config.rules && config.rules['no-console'] === 'off'
    );
    expect(entry).toBeDefined();
    expect(entry.files).toEqual(['apps/api/src/lib/telemetry/console-adapter.ts']);
    expect(path.isAbsolute(entry.basePath)).toBe(true);
    expect(existsSync(path.join(entry.basePath, entry.files[0]))).toBe(true);
  });
});
