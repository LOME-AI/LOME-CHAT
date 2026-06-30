/**
 * Redaction lint extension: the three vendored telemetry-redaction rules
 * (content must never reach logs — see docs/CODE-RULES.md, Telemetry).
 *
 * Loaded via the eslint-extensions slot. All three rules self-scope by
 * ABSOLUTE filename to the backend logging perimeter (the API's slices, lib,
 * middleware, and app entry, plus the realtime package's Durable Object
 * sources), so the `files` globs below can stay broad and behave identically
 * regardless of which package's eslint.config.js provides the glob base path.
 *
 * Test files are excluded: the compile-time rejection fixtures
 * (@ts-expect-error tests for the SafeLogFields logger) must be able to WRITE
 * the violating call shapes these rules ban, and tests are not a Workers
 * Logs emission path.
 */
import { fileURLToPath } from 'node:url';
import loggerMsgLiteral from './rules/logger-msg-literal.mjs';
import noRawConsole from './rules/no-raw-console.mjs';
import noSensitiveLogArgument from './rules/no-sensitive-log-argument.mjs';

// Repo root, derived from this file's location (packages/config/
// eslint-extensions/). Used to anchor the adapter exemption below so it can
// never match a lookalike path in another package.
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

const redactionPlugin = {
  meta: { name: 'redaction', version: '1.0.0' },
  rules: {
    'no-raw-console': noRawConsole,
    'no-sensitive-log-argument': noSensitiveLogArgument,
    'logger-msg-literal': loggerMsgLiteral,
  },
};

export default [
  {
    name: 'redaction',
    files: ['**/*.ts', '**/*.tsx'],
    ignores: ['**/*.test.ts', '**/*.test.tsx'],
    plugins: { redaction: redactionPlugin },
    rules: {
      'redaction/no-raw-console': 'error',
      'redaction/no-sensitive-log-argument': 'error',
      'redaction/logger-msg-literal': 'error',
    },
  },
  {
    // The base config's no-console allows only warn/error; the telemetry
    // console adapter is the designated console caller and maps log levels
    // onto console.debug/info too. Targeted override for that one file —
    // everywhere else in the perimeter the vendored no-raw-console rule bans
    // console outright. basePath pins the glob to the repo root regardless of
    // which package's eslint.config.js consumes this extension.
    name: 'redaction-console-adapter-exemption',
    basePath: REPO_ROOT,
    files: ['apps/api/src/lib/telemetry/console-adapter.ts'],
    rules: {
      'no-console': 'off',
    },
  },
];
