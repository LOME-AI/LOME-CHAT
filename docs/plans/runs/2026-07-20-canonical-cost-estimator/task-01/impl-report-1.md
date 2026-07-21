# T1 — Canonicalize nano-USD money primitives into `packages/shared`

## Objective
Move the nano-USD money primitives (`applyMarkup`, `MARKUP_BASIS_POINTS`, `roundHalfEvenDiv`,
`usdToNanoUsd`) into `packages/shared/src/money.ts`, exported from the shared barrel. The
billing slice's `money.ts` re-exports them from `@hushbox/shared` so every existing api caller
keeps working unchanged. The `assertMarkupMatchesSharedRate` drift guard against `TOTAL_FEE_RATE`
stays in api `money.ts` and still runs at module init. Behavior byte-identical; no float in the
money path.

## Files changed
- `packages/shared/src/money.ts` (new) — canonical home of `BASIS` (private), `MARKUP_BASIS_POINTS`,
  `roundHalfEvenDiv`, `applyMarkup`, `usdToNanoUsd`. Implementation copied verbatim from the former
  api `money.ts` (same constants: `BASIS = 10_000n`, `MARKUP_BASIS_POINTS = 1500n`, half-even
  rounding, `NANO_FRACTION_DIGITS = 9`, `RENDER_DIGITS = 12`).
- `packages/shared/src/money.test.ts` (new) — ported unit tests for the four moved primitives
  (written first, watched fail).
- `packages/shared/src/index.ts` — added `export { MARKUP_BASIS_POINTS, applyMarkup, roundHalfEvenDiv, usdToNanoUsd } from './money.js';`
  (placed with the other money exports, above the `nano-usd` block; explicit-named style consistent
  with the surrounding barrel).
- `apps/api/src/slices/billing/domain/money.ts` — removed the four primitives' implementations;
  now `export { MARKUP_BASIS_POINTS, applyMarkup, roundHalfEvenDiv, usdToNanoUsd } from '@hushbox/shared';`
  (satisfies `unicorn/prefer-export-from`). Still imports `MARKUP_BASIS_POINTS` (used by the markup
  guard) plus the shared storage floats, and retains the storage nano constants, both drift guards,
  and both module-init assertions.

No changes needed to `apps/api/src/slices/billing/{domain/,}index.ts`: they already re-export the
primitives from `./money.js`, whose re-export forwards the same names — the whole api suite (which
imports through those barrels) is green.

## How each T1 acceptance criterion is satisfied
- **Move the four primitives into `packages/shared/src/money.ts`, exported from the barrel** — done;
  new file + barrel export line. Verified importable as `from './money.js'` by the new shared test
  and via `@hushbox/shared` by api `money.ts`.
- **api `money.ts` re-exports from `@hushbox/shared`; existing callers unchanged** — done via
  `export … from`. All api callers (`charge.ts`, `settlement.ts`, `estimate.ts`,
  `smart-model-candidates.ts`, dev/seed, billing barrels, workflow nodes, …) import through
  `./money.js` or the billing barrel unchanged; full api suite green (5746 pass).
- **Keep the `assertMarkupMatchesSharedRate` drift guard against `TOTAL_FEE_RATE`; it must still run
  and still guard** — kept in api `money.ts`; module-init call `assertMarkupMatchesSharedRate(TOTAL_FEE_RATE)`
  retained. The guard compares `BigInt(Math.round(totalFeeRate * 10_000))` to the (now shared)
  `MARKUP_BASIS_POINTS`. api `money.test.ts` still exercises the accept + drift cases (green).
- **Byte-identical behavior: BASIS 10000n, MARKUP_BASIS_POINTS 1500n, half-even rounding; no float**
  — implementation copied verbatim; identical constants. Money path is all `bigint`; the only
  `number` inputs are `usdToNanoUsd(usd)` (gateway float, converted via decimal-string rendering, no
  float multiplication) and the two guards' `Math.round` on rate floats (guard math, not ledger
  amounts) — unchanged from before.

## TDD evidence
1. Wrote `packages/shared/src/money.test.ts` (20 tests over the four primitives) BEFORE creating
   `money.ts`.
2. Ran `pnpm test:watch src/money.test.ts` → **RED** for the right reason:
   `Error: Cannot find module './money.js'` (module missing, not a typo/logic error).
3. Created `packages/shared/src/money.ts`, re-ran → **GREEN**: 20 passed.
4. Ran api `money.test.ts` (unchanged, now exercising the re-export) → **GREEN**: 26 passed.

## Commands run (final results, after last edit)
- `pnpm test:watch packages/shared/src/money.test.ts` → 20 passed.
- `pnpm test:watch apps/api/.../billing/domain/money.test.ts` → 26 passed.
- `pnpm test:shared` → exit 0; 89 files, **2233 passed**; `money.ts` coverage **100/100/100/100**.
- `pnpm test:api` → exit 0; 422 files (6 pre-existing skipped), **5746 passed** (7 pre-existing
  skipped); billing `money.ts` coverage **100/100/100/100**.
- `npx turbo typecheck lint --filter=@hushbox/shared --filter=@hushbox/api --force` → exit 0, zero
  warnings (after the export-from fix below).
- `npx jscpd --threshold 2` on the changed files → **0 clones (0%)** — the re-export introduces no
  duplicated implementation.

Note on the initial combined test run: running `pnpm test:shared` and `pnpm test:api` concurrently
raced on `db:migrate` (a stack-setup step), producing a spurious migrate error; re-run sequentially,
both are clean (exits captured explicitly, not through a `tail` pipe).

## Deviations from the plan
- The plan listed `apps/api/src/slices/billing/{domain/,}index.ts` as possibly-touched files; they
  needed no edit because they already re-export the primitives from `./money.js` and the forwarded
  names are unchanged. (Not a behavior deviation — barrels unchanged, callers unaffected.)
- First typecheck+lint pass flagged `unicorn/prefer-export-from` on the initial
  `import … ; export { … }` form in api `money.ts`. Fixed to `export … from '@hushbox/shared'`
  (`MARKUP_BASIS_POINTS` is additionally imported because the markup guard uses it). Re-lint clean.

## For the auditor to scrutinize
- The markup drift guard was intentionally left in api `money.ts` (per brief: my call). Both
  `MARKUP_BASIS_POINTS` and `TOTAL_FEE_RATE` now live in `packages/shared`, so the guard could
  instead live in shared; I kept it in api to keep the api module's init-time behavior and its
  existing test (`money.test.ts`) unchanged. It still runs and still throws on drift (pinned by the
  api test's `assertMarkupMatchesSharedRate(0.2)` case).
- `unicorn/prefer-export-from` — confirm the final `export … from` form is what the rule wants
  (lint exit 0 confirms).
- Storage nano constants + `assertStorageRatesMatchSharedFloats` remain in api `money.ts` (out of
  T1's four-primitive scope, deliberately untouched).

## Confidence
High — verbatim move, both full suites green, both moved-file coverages 100%, typecheck/lint/jscpd
clean after the last edit.
