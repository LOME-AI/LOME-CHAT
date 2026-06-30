import {
  createBaseConfig,
  workersConfig,
  testConfig,
  devServicesConfig,
  prettierConfig,
} from '@hushbox/config/eslint';

/** @type {import('eslint').Linter.Config[]} */
export default [
  // src/legacy is the demoted reference corpus, excluded from the package
  // tsconfig, so the type-aware project service cannot lint it.
  { ignores: ['.wrangler/**', 'src/legacy/**'] },
  ...createBaseConfig(import.meta.dirname),
  ...workersConfig,
  ...devServicesConfig,
  ...testConfig,
  prettierConfig,
];
