import { createBaseConfig, reactConfig, testConfig, prettierConfig } from '@hushbox/config/eslint';

/** @type {import('eslint').Linter.Config[]} */
export default [
  {
    ignores: ['src/routeTree.gen.ts'],
  },
  ...createBaseConfig(import.meta.dirname),
  ...reactConfig,
  ...testConfig,
  prettierConfig,
];
