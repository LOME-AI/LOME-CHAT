/**
 * No-silent-catch-swallow lint set (audit F20). One vendored rule,
 * path-scoped-inert: it acts ONLY on non-test files under
 * `apps/api/src/{slices,lib}/` and is silent everywhere else. There a `catch`
 * block must visibly handle its failure — a `throw`, a `captureError(...)`
 * call, or the construction/return of a typed error/Result (an `err(...)` call
 * or a `*DomainError` reference); empty catches are banned outright. A rare
 * legitimate swallow escapes via a justified `eslint-disable` line.
 *
 * Loaded via the eslint-extensions slot (every *.config.mjs here is composed
 * into the shared flat config by `load-extensions.mjs`). The rule self-scopes
 * by ABSOLUTE filename, so the broad `files` glob below behaves identically
 * regardless of which package's eslint.config.js provides the glob base path.
 */
import catchSwallow from './rules/catch-swallow.mjs';

const catchSwallowPlugin = {
  meta: { name: 'catch-swallow', version: '1.0.0' },
  rules: {
    'no-silent-catch': catchSwallow,
  },
};

export default [
  {
    name: 'catch-swallow',
    files: ['**/*.ts', '**/*.tsx'],
    plugins: { 'catch-swallow': catchSwallowPlugin },
    rules: {
      'catch-swallow/no-silent-catch': 'error',
    },
  },
];
