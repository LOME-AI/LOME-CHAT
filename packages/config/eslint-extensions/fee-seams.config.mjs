/**
 * Fee-seam confinement lint extension: the vendored fee-seams rule.
 *
 * BILLING.md §Fee Structure: the customer markup is applied in exactly two
 * money-path places — catalog rate baking at ingestion (ceil) and the
 * ModelProvider port's charge conversion (half-even) — plus the
 * definition-time constants that bake a raw provider figure billable once at
 * module init. This extension makes that structural: importing a fee helper
 * (`applyMarkup*` from shared money) anywhere else fails lint, so fee
 * application can never quietly spread back into estimators, settlement, or
 * client code. Applies repo-wide (every package linting through
 * createBaseConfig); the rule self-scopes by absolute importer filename, so
 * the broad `files` glob is safe under any package's glob base path.
 */
import feeSeams from './rules/fee-seams.mjs';

/**
 * The sanctioned fee-application seams — the ONE authoritative list, matched
 * as repo-relative path suffixes of the importing file. Each site carries a
 * comment stating why it is a seam:
 *
 * - `packages/shared/src/money.ts` — defines the helpers; fee math composes
 *   internally here and nowhere else.
 * - `packages/shared/src/index.ts` — the root barrel publishes the helpers to
 *   the sanctioned cross-package seams (publication, not application).
 * - `packages/shared/src/estimate/search-reservation.ts` — the web-search
 *   reservation constant: a raw provider per-call figure baked billable once
 *   at definition (ceil).
 * - `apps/api/src/slices/models/domain/normalize.ts` — catalog ingestion:
 *   every stored rate baked billable (ceil), the first of the two money-path
 *   seams.
 * - `apps/api/src/slices/billing/domain/money.ts` — the ModelProvider port's
 *   charge conversion (half-even), the second money-path seam.
 * - `scripts/lib/e2e-seeded-image-model.ts` — the synthetic e2e catalog row's
 *   rate, baked with the same ceil helper so the seeded row can never drift
 *   from what ingestion would store.
 */
export const FEE_APPLICATION_SEAMS = [
  'packages/shared/src/money.ts',
  'packages/shared/src/index.ts',
  'packages/shared/src/estimate/search-reservation.ts',
  'apps/api/src/slices/models/domain/normalize.ts',
  'apps/api/src/slices/billing/domain/money.ts',
  'scripts/lib/e2e-seeded-image-model.ts',
];

const moneyPlugin = {
  meta: { name: 'money', version: '1.0.0' },
  rules: {
    'fee-seams': feeSeams,
  },
};

export default [
  {
    name: 'fee-seams',
    files: ['**/*.ts', '**/*.tsx'],
    plugins: { money: moneyPlugin },
    rules: {
      'money/fee-seams': ['error', { allowedFiles: FEE_APPLICATION_SEAMS }],
    },
  },
];
