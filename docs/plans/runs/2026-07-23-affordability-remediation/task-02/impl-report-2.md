# Task 02 — impl report 2 (fix)

## Objective

Fix the one validated audit finding: the synthetic E2E image-model producer
(`scripts/lib/e2e-seeded-image-model.ts`) was not updated for the descriptor-v2
contract — missing `version` (typecheck + runtime `ModelDescriptor.parse` failure on
`pnpm db:seed`) and storing the pre-fee provider rate `'40000000'` instead of the
billable `'46000000'`.

## Files changed

- `scripts/lib/e2e-seeded-image-model.ts` — content stamps
  `version: DESCRIPTOR_VERSION` (imported, not hardcoded); per-image rate is now
  `applyMarkupCeil(40_000_000n).toString()` (= `'46000000'`) computed from the raw
  provider rate through the SAME shared ceil-markup helper normalize uses, so the
  seed can never drift from what `catalog:refresh` would store.
- `scripts/lib/e2e-seeded-image-model.test.ts` — v2 pins (see Tests); the
  descriptor-contract test now parses the content **as-is** (exactly what
  `upsertCatalog` parses: content + `fetchedAt`, nothing patched) instead of
  patching `version: '1'`.
- `apps/api/src/slices/models/domain/index.ts`,
  `apps/api/src/slices/models/index.ts`,
  `apps/api/src/platform/dev/seed-toolkit.ts` — one-line-per-barrel additions
  exporting `DESCRIPTOR_VERSION` (defined by Task 02 in `normalize.ts`) through the
  models slice barrel and the sanctioned `@hushbox/api/dev-seed` subpath, per the
  brief's explicit in-bounds allowance ("if the version constant is not exported…").
  It is not exported from `packages/shared`; this chain (normalize → domain barrel →
  slice barrel → dev-seed) is the only sanctioned route into scripts.

## Tests added / changed

All in `scripts/lib/e2e-seeded-image-model.test.ts`, watched red first:

- `stamps the current descriptor version (v2 = billable rates)` —
  `content.version === DESCRIPTOR_VERSION` (red: `undefined` ≠ `'2'`).
- `stores the BILLABLE per-image rate — ceil markup over the $0.04 provider rate` —
  pins both the derivation (`applyMarkupCeil(40_000_000n).toString()`) and the
  literal `'46000000'` (red: received `'40000000'`).
- `builds a descriptor that satisfies the ModelDescriptor contract as-is (the seed
  parse path)` — reshaped to parse `{...content, fetchedAt}` unpatched, mirroring
  `upsertCatalog`'s `ModelDescriptor.parse` (catalog-store.ts) — this is the
  unit-level proof the `pnpm db:seed` parse path accepts the descriptor (red:
  `safeParse.success === false` on the missing version).

Red run: 3 failed / 5 passed, each failing for the diagnosed reason. Green run after
the fix: 8/8. (No live-DB seed run — stack not up, per the brief.)

## Self-gate

- `pnpm test:watch scripts/lib/e2e-seeded-image-model.test.ts` — pass (8/8), re-run
  green after the final lint-fix edit.
- `turbo typecheck --filter=@hushbox/scripts --force` — pass (this is the finding's
  "repo typecheck fails at 41,5" — now exit 0). Re-run via `pnpm run typecheck` in
  `scripts/` after the final edit — pass.
- `turbo typecheck --filter=@hushbox/api --force` — pass (barrel edits; also note the
  prior report's 6 concurrent-lane `budgets.ts` errors are gone on the current tree).
- `eslint` on all 5 owned files, run from `scripts/` and `apps/api/` after the final
  edit — exit 0 (one `import/order` error surfaced and was fixed, then re-linted).
- `turbo test --filter=@hushbox/scripts --force` (full scripts suite + coverage) —
  **2 failed test files, 0 failed tests (1745/1754 pass, 84/86 files), NOT mine** —
  attribution below.
- `turbo test --filter=@hushbox/api --force` — 445/447 files, 6091/6100 tests pass;
  **1 failed file (7 tests), NOT mine**: `slices/notifications/domain/templates/`
  `template-html.test.ts` — the identical pre-existing failure impl-report-1
  attributed (same file, same 7 snapshot mismatches: committed `base.ts` lacks the
  Google-Fonts link the committed snapshots expect); the templates dir is unmodified
  in the working tree (`git status` clean there) and untouched by this fix.

### Attribution of the 2 scripts suite failures

`refresh-catalog-run.test.ts` and `seed-run.test.ts` both fail at collection with
`ERR_MODULE_NOT_FOUND` on `…/.vite/vitest/<hash>/deps_ssr/@hushbox_db.js&v=298cf945`
— a mangled optimized-dep URL (`&v=` where `?v=` belongs) raised from vitest's own
`module-evaluator.js` while `vi.mock('@hushbox/db', importOriginal)` loads. Evidence
it is not mine:

- The optimized dep file **exists** and `_metadata.json`'s `browserHash` is exactly
  `298cf945` — the loader mangles the URL; no cache staleness (verified after two
  full cache wipes of `scripts/node_modules/.vite` + `.tmp`; failure identical).
- Reproduces with **all three of my `apps/api` barrel edits temporarily reverted**,
  and `refresh-catalog-run.test.ts`'s module graph contains **neither** of my
  scripts files (`e2e-seeded-image-model.*` is imported only by `seed.ts` and its
  own test). A graph with zero of my edits fails identically → pre-existing on the
  working tree (vitest 4.1.8 SSR-optimized-dep mock resolution), not caused by this
  fix. Reverts were restored from byte-identical backups afterward.
- These are the only 2 failures; every executed test passes (1754/1754), including
  my 8.

## Acceptance criteria (the validated finding)

- `version` stamped so typecheck passes and `ModelDescriptor.parse` accepts — **met**
  (`DESCRIPTOR_VERSION` import; scripts typecheck exit 0; as-is parse test green).
- Billable rate stored, not provider rate — **met** (`applyMarkupCeil` over the
  provider constant; `'46000000'` pinned, matching the live seedream-4.5 pin in
  `refresh.integration.test.ts`).
- Unit test no longer patches `version: '1'` — **met** (patch removed; parse-as-is).
- No hardcoding of version/markup — **met** (both imported from canonical homes;
  the barrel-export additions are declared above as the brief allowed).

## Deviations

- Three barrel lines edited in `apps/api` (domain barrel, slice barrel, dev-seed
  toolkit) outside the two named source files — pre-authorized by the brief's
  implementation note; there is no shorter sanctioned export chain.

## Concerns / limitations

- The 2 pre-existing scripts suite collection failures (above) block a fully green
  `turbo test --filter=@hushbox/scripts`; they need their own owner (vitest
  optimized-dep mock resolution), out of my file ownership.
- `pnpm db:seed` was not run against a live DB (stack down, per brief); the parse
  path is proven at unit level against the exact `upsertCatalog` parse shape.

## Confidence

High — the finding's three defects each had a red test watched failing for exactly
the diagnosed reason and all are green; typecheck (the finding's primary symptom)
passes in both affected packages; the only remaining failures reproduce on a module
graph containing none of my edits.
