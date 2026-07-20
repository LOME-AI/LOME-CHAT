import {
  createBaseConfig,
  workersConfig,
  testConfig,
  devServicesConfig,
  prettierConfig,
} from '@hushbox/config/eslint';

/** @type {import('eslint').Linter.Config[]} */
export default [
  { ignores: ['.wrangler/**'] },
  ...createBaseConfig(import.meta.dirname),
  ...workersConfig,
  ...devServicesConfig,
  ...testConfig,
  prettierConfig,
];
