/**
 * Routing-options lint extension: bans inline OpenRouter provider-routing / ZDR
 * option literals in the model adapters so every call's ZDR block comes from
 * the single-sourced shared helpers.
 *
 * Loaded via the eslint-extensions slot. The rule self-scopes by ABSOLUTE
 * filename (default: apps/api/src/slices/models/adapters), so the broad `files`
 * glob below behaves identically regardless of which package's eslint.config.js
 * provides the glob base path.
 */
import noInlineRoutingOptions from './rules/no-inline-routing-options.mjs';

const routingOptionsPlugin = {
  meta: { name: 'routing-options', version: '1.0.0' },
  rules: {
    'no-inline-routing-options': noInlineRoutingOptions,
  },
};

export default [
  {
    name: 'routing-options',
    files: ['**/*.ts', '**/*.tsx'],
    plugins: { 'routing-options': routingOptionsPlugin },
    rules: {
      'routing-options/no-inline-routing-options': 'error',
    },
  },
];
