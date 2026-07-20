/**
 * Legacy-corpus isolation lint extension: the vendored no-legacy-imports rule.
 *
 * The legacy corpus is quarantined in the repo-root `/legacy/` directory — a
 * non-running reference archive; new code must never depend on it. The rule
 * applies repo-wide (every package linting through createBaseConfig) and
 * exempts importers that themselves live under `/legacy/` by absolute filename,
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
