/**
 * Runtime-primitives lint extension: the vendored must-use-Result rule and
 * the cockatiel import restriction.
 *
 * Loaded via the eslint-extensions slot (every *.config.mjs here is composed
 * into the shared flat config). Both rules self-scope by ABSOLUTE filename
 * (must-use-result: apps/api/src/{slices,lib}; no-external-cockatiel: allowed
 * only in apps/api/src/lib/resilience), so the `files` globs below can stay
 * broad and the entries behave identically regardless of which package's
 * eslint.config.js provides the glob base path.
 */
import mustUseResult from './rules/must-use-result.mjs';
import noExternalCockatiel from './rules/no-external-cockatiel.mjs';

const runtimePrimitivesPlugin = {
  meta: { name: 'runtime-primitives', version: '1.0.0' },
  rules: {
    'must-use-result': mustUseResult,
    'no-external-cockatiel': noExternalCockatiel,
  },
};

export default [
  {
    name: 'runtime-primitives',
    files: ['**/*.ts', '**/*.tsx'],
    plugins: { 'runtime-primitives': runtimePrimitivesPlugin },
    rules: {
      'runtime-primitives/must-use-result': 'error',
      'runtime-primitives/no-external-cockatiel': 'error',
    },
  },
];
