// @ts-check
import {
  createBaseConfig,
  nodeConfig,
  testConfig,
  scriptsConfig,
  prettierConfig,
} from '@hushbox/config/eslint';

/** @type {import('eslint').Linter.Config[]} */
export default [
  // The legacy_* reference corpus is excluded from the package tsconfig,
  // so the type-aware project service cannot lint it.
  { ignores: ['**/legacy_*'] },
  ...createBaseConfig(import.meta.dirname),
  ...nodeConfig,
  ...testConfig,
  ...scriptsConfig,
  prettierConfig,
];
