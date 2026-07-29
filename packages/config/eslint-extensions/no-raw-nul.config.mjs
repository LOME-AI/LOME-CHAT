/**
 * Text-invisibility lint extension: the vendored no-raw-nul rule.
 *
 * A raw NUL byte makes `ugrep` (the repo's grep) treat a source file as binary
 * and skip it with no match, no warning and exit 0 — every sweep over that file
 * silently returns nothing. The rule applies repo-wide and carries no path
 * exemptions, so the broad `files` globs below are correct under any package's
 * glob base path.
 *
 * This lives in the lint gate rather than the `arch:check` harness for two
 * reasons: `arch:check` is scoped to the backend source trees, and both known
 * offenders were under `apps/web`, so covering them would mean widening that
 * harness's globs — which hands every arch rule a new file set at once. Lint
 * already runs over every package's source in CI and on pre-push, and it fronts
 * the rest of the CI DAG, so a violation blocks loudly and immediately.
 *
 * `.astro` is deliberately absent from the globs: the astro parser rejects a
 * raw NUL as a parse error before any rule runs, so lint already fails there
 * and this rule could never fire on one.
 */
import noRawNul from './rules/no-raw-nul.mjs';

const textPlugin = {
  meta: { name: 'text', version: '1.0.0' },
  rules: {
    'no-raw-nul': noRawNul,
  },
};

export default [
  {
    name: 'no-raw-nul',
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx', '**/*.mjs', '**/*.cjs'],
    plugins: { text: textPlugin },
    rules: {
      'text/no-raw-nul': 'error',
    },
  },
];
