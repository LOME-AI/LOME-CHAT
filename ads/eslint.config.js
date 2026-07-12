import { createBaseConfig, nodeConfig, prettierConfig } from '@hushbox/config/eslint';

/** @type {import('eslint').Linter.Config[]} */
export default [
  ...createBaseConfig(import.meta.dirname),
  ...nodeConfig,
  prettierConfig,
  // Media archives are data, not source.
  { ignores: ['*/0*-*/**/*.mp4', '*/0*-*/**/*.png', '*/0*-*/**/*.wav', '*/0*-*/**/*.webm'] },
];
