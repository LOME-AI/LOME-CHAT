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
  {
    // `public/render.js` and `public/python.js` are the generated, minified
    // renderer/runtime bundles (built from src/render and src/python by
    // `build:render`/`build:python`); they are build outputs, not authored source.
    ignores: ['dist', 'public/pyodide', 'public/render.js', 'public/python.js'],
  },
  ...createBaseConfig(import.meta.dirname),
  ...nodeConfig,
  ...testConfig,
  ...scriptsConfig,
  prettierConfig,
];
