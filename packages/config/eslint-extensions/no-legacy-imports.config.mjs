/**
 * Legacy-corpus isolation lint extension: the vendored no-legacy-imports rule.
 *
 * Legacy-prefixed artifacts (`legacy_*` files, `legacy-*` dirs, `legacy/`
 * trees) are a non-running reference corpus; new code must never depend on
 * them. The rule applies repo-wide (every package linting through
 * createBaseConfig) and exempts legacy-named importers by absolute filename,
 * so the broad `files` glob below is safe under any package's glob base path.
 */
import noLegacyImports from './rules/no-legacy-imports.mjs';

const legacyPlugin = {
  meta: { name: 'legacy', version: '1.0.0' },
  rules: {
    'no-legacy-imports': noLegacyImports,
  },
};

export default [
  {
    name: 'no-legacy-imports',
    files: ['**/*.ts', '**/*.tsx'],
    plugins: { legacy: legacyPlugin },
    rules: {
      'legacy/no-legacy-imports': 'error',
    },
  },
];
