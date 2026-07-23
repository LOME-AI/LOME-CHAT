/**
 * Reasoning-format ownership lint extension: the vendored
 * no-think-tag-literal rule.
 *
 * G7: the canonical inline reasoning format (`<think>…</think>`) has exactly
 * one owner — `packages/shared/src/reasoning-format.ts`. The rule applies
 * repo-wide (every package linting through createBaseConfig) and exempts the
 * parser module and its colocated test by absolute filename, so the broad
 * `files` glob below is safe under any package's glob base path.
 */
import noThinkTagLiteral from './rules/no-think-tag-literal.mjs';

const reasoningFormatPlugin = {
  meta: { name: 'reasoning-format', version: '1.0.0' },
  rules: {
    'no-think-tag-literal': noThinkTagLiteral,
  },
};

export default [
  {
    name: 'no-think-tag-literal',
    files: ['**/*.ts', '**/*.tsx'],
    plugins: { 'reasoning-format': reasoningFormatPlugin },
    rules: {
      'reasoning-format/no-think-tag-literal': 'error',
    },
  },
];
