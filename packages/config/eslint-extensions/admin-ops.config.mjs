/**
 * Admin op-body purity lint set. One vendored rule, path-scoped-inert: it
 * acts ONLY on files under `apps/api/src/slices/admin/domain/operations/`
 * and is silent everywhere else. There it bans raw Date.now/Math.random/
 * fetch and infra/adapter value imports — an op body composes published
 * slice barrels on the engine-owned `SettlementTx` and nothing else (the
 * Reversibility Iron Law's no-external-calls consequence). The structural
 * half (op modules importable only by the admin registry wiring) lives in
 * the `admin-op-purity` ts-morph arch rule.
 *
 * Loaded via the eslint-extensions slot. The rule self-scopes by ABSOLUTE
 * filename, so the broad `files` glob below behaves identically regardless
 * of which package's eslint.config.js provides the glob base path.
 */
import adminOpPurity from './rules/admin-op-purity.mjs';

const adminOpsPlugin = {
  meta: { name: 'admin-ops', version: '1.0.0' },
  rules: {
    'op-purity': adminOpPurity,
  },
};

export default [
  {
    name: 'admin-ops',
    files: ['**/*.ts', '**/*.tsx'],
    plugins: { 'admin-ops': adminOpsPlugin },
    rules: {
      'admin-ops/op-purity': 'error',
    },
  },
];
