import { createBaseConfig, testConfig, prettierConfig } from '@hushbox/config/eslint';

/** @type {import('eslint').Linter.Config[]} */
export default [
  // The legacy_* / legacy-* reference corpus is excluded from the package
  // tsconfig, so the type-aware project service cannot lint it.
  { ignores: ['src/**/legacy_*', 'src/legacy-zod/**'] },
  ...createBaseConfig(import.meta.dirname),
  ...testConfig,
  prettierConfig,
];
