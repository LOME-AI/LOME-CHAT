/**
 * Idempotency lint extension: the vendored brand-cast ban and the brand-
 * module import confinement. The two close the brand-forgery surface
 * together — no cast anywhere, no constructor import outside the module.
 *
 * Loaded via the eslint-extensions slot (every *.config.mjs here is composed
 * into the shared flat config). Both rules self-scope by ABSOLUTE filename
 * (casts allowed only in apps/api/src/lib/idempotency/brands.ts — the
 * brand-minting module; brands imports allowed only under
 * apps/api/src/lib/idempotency/), so the `files` glob below can stay broad
 * and the entry behaves identically regardless of which package's
 * eslint.config.js provides the glob base path.
 */
import noBrandCast from './rules/no-idempotency-brand-cast.mjs';
import noBrandImport from './rules/no-idempotency-brand-import.mjs';

const idempotencyPlugin = {
  meta: { name: 'idempotency', version: '1.0.0' },
  rules: {
    'no-brand-cast': noBrandCast,
    'no-brand-import': noBrandImport,
  },
};

export default [
  {
    name: 'idempotency',
    files: ['**/*.ts', '**/*.tsx'],
    plugins: { idempotency: idempotencyPlugin },
    rules: {
      'idempotency/no-brand-cast': 'error',
      'idempotency/no-brand-import': 'error',
    },
  },
];
