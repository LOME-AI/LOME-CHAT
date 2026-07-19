/**
 * no-external-sentry lint extension: confines `@sentry/*` imports to the
 * telemetry Sentry adapter, mirroring how no-external-cockatiel confines
 * `cockatiel` to the resilience policy factory.
 *
 * Loaded via the eslint-extensions slot (every *.config.mjs here is composed
 * into the shared flat config). The rule self-scopes by ABSOLUTE filename
 * (allowed only under apps/api/src/lib/telemetry/adapters), so the `files`
 * glob below stays broad and behaves identically regardless of which
 * package's eslint.config.js provides the glob base path.
 */
import noExternalSentry from './rules/no-external-sentry.mjs';

const noExternalSentryPlugin = {
  meta: { name: 'no-external-sentry', version: '1.0.0' },
  rules: {
    'no-external-sentry': noExternalSentry,
  },
};

export default [
  {
    name: 'no-external-sentry',
    files: ['**/*.ts', '**/*.tsx'],
    plugins: { 'no-external-sentry': noExternalSentryPlugin },
    rules: {
      'no-external-sentry/no-external-sentry': 'error',
    },
  },
];
