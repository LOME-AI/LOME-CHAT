# Task 02 — impl report 1

## Objective

Catalog stores billable (after-fee) rates: ceil-rounded 15% markup baked into every
pricing rate at normalize time, descriptor `version: '2'`, catalog read path fail-fast
on v1 rows. Option A per plan §Task 02; zero-users ruling — no backfill/migration
machinery.

## Files changed

- `packages/shared/src/money.ts` — `applyMarkupCeil(baseCostNanoUsd: bigint): bigint`
  beside `applyMarkup`; exact bigint `(base × 11500 + 9999) / 10000` ceil; rejects
  negative bases.
- `packages/shared/src/index.ts` — barrel export of `applyMarkupCeil`.
- `packages/shared/src/money.test.ts` — new `applyMarkupCeil` describe (see Tests).
- `apps/api/src/slices/models/domain/normalize.ts` —
  - `DESCRIPTOR_VERSION = '2'` exported constant with the v1/v2 semantics comment.
  - `DescriptorContent` now includes `version` (Omit only `fetchedAt`/`popularityRank`),
    so a version bump is part of the skip-unchanged content hash and rewrites every row.
  - Each family's content literal stamps `version: DESCRIPTOR_VERSION`; `mergeContent`
    carries `base.version`.
  - `bakeFees`/`billablePricing`/`billableRate`: every pricing rate — flat string and
    one-level matrix — is ceil-marked-up at the single `normalizeModel` choke point,
    after family dispatch and before the same-id merge (merge only spreads
    already-baked rates, so exactly-once holds for merged folds and video fallback
    substitution alike).
- `apps/api/src/slices/models/domain/catalog-store.ts` — `upsertCatalog` no longer
  stamps `version: '1'`; version comes from the content, only `fetchedAt` is stamped
  at persist.
- `apps/api/src/slices/models/domain/refresh.ts` — `storedContentMatches` filters only
  `fetchedAt` (version participates in the compare); the in-memory latest row drops its
  `version: '1'` literal. **Deviation note below.**
- `apps/api/src/slices/models/domain/list-descriptors.ts` — the fail-fast: the product
  read choke point (`pricing-resolver`, `list-models`, `smart-model-candidates` all fold
  over `listDescriptors`) refuses the WHOLE read with a typed `unavailable` DomainError
  when any row's descriptor version ≠ '2'; corrupt-row skip-with-alert behavior is
  unchanged. Per-row logic extracted to `rowOutcome` (lint cognitive-complexity cap).
- Test fixtures seeding `model_catalog` rows bumped `version: '1'` → `'2'` (they now
  seed data the read path accepts): `apps/api/src/app-mount.integration.test.ts`,
  `slices/models/routes.integration.test.ts`, `slices/models/adapters/integration-setup.ts`,
  `slices/models/domain/{admin-disabled,catalog-store,list-descriptors,refresh}.integration.test.ts`,
  `slices/chat/routes.integration.test.ts`,
  `slices/chat/domain/{regenerate,smart-model-turn,turn-definition}.integration.test.ts`,
  `slices/admin/routes-reads.integration.test.ts`, `platform/dev/routes.integration.test.ts`,
  `jobs/public-stats-snapshot-entry.integration.test.ts`,
  `slices/workflows/engine/smart-model.integration.test.ts`. Unit-test fixtures that
  never traverse the read path were left untouched (surgical).
- `apps/api/src/slices/models/domain/normalize.test.ts` — pinned rates updated to
  billable values + new fee-baking describe.

## Tests added

All watched red before implementation (applyMarkupCeil missing → TypeError; pre-fee
rates/version '1' before normalize change; Ok result before the fail-fast).

- `money.test.ts › applyMarkupCeil` — exact 15% on whole dollars; zero base; fractional
  nano rounds UP (1n→2n, 3n→4n); **ceil-vs-half-even divergence** (30n: half-even 34
  vs ceil 35; 2n: half-even 2 vs ceil 3); **bigint exactness** at 10^30+1; **ceil
  property sweep** (∀ base<2000: least integer ≥ exact 1.15× product); **only-over-
  reserve invariant** (ceil ≥ half-even ∀ base<2000); negative rejected. → criterion 3.
- `normalize.test.ts › fee baking` — version '2' stamped on all three families; ceil
  on a fractional flat rate (1 nano → '2'); **merged same-id fold marked up exactly
  once** ('2875'/'11500', not double); **video fallback substitution marked up exactly
  once** (both stated and substituted resolution '57500000'). Plus every pre-existing
  pinned rate re-pinned at billable (language flat incl. cachedInput; image `perImage`;
  video matrix across all SKU-interpreter cases). → criterion 1 (all shapes: flat +
  matrix, language/image/video).
- `refresh.integration.test.ts` — 'overwrites a corrupt stored descriptor' now expects
  `version: '2'`; **new** 're-bakes a stored v1 row on the next refresh — version is in
  the content hash' (write v2 → force row to v1 → identical metadata refresh rewrites
  it, `written: 1`). → criterion 1/2 recovery story.
- `catalog-store.integration.test.ts` — persisted-contract test expects `version: '2'`.
- `list-descriptors.integration.test.ts` — **new** 'fails the whole read fast on an
  unbaked v1 descriptor row — never a silent skip': seeded v1 row ⇒ `Err` with code
  `unavailable` and a message naming the version; poison row deleted inside the test
  before the catalog lock releases. → criterion 2 (clear error, fail-fast, not a skip).

## Proof estimator/settlement untouched

`git status`/diff confirm zero edits under `packages/shared/src/estimate/`,
`packages/shared/src/pricing.ts`, the ModelProvider port, and all settlement code
(T03/T04 territory). The estimator therefore still applies `applyMarkup` on top of
now-billable rates — double markup on estimates until T03 lands, which is the plan's
deliberate T02→T03 sequencing (estimates only over-reserve in the interim, never
under).

## Self-gate

- `pnpm test:shared` — 102 files / 2256 tests pass; **1 coverage failure, not mine**:
  `src/estimate/smart-model-affordability.ts` branches 86.02% < 95. That file, its
  tests, and the whole `estimate/` dir are untouched by me (clean in `git status`); my
  shared edits are `money.ts`/`money.test.ts`/`index.ts` only and per-file coverage is
  per-file. Pre-existing or concurrent-lane fallout; T03 rewrites that file anyway.
- `pnpm test:api` — final full run: 445 files / 6090 tests pass, no coverage
  shortfalls; **1 failing file, not mine**:
  `slices/notifications/domain/templates/template-html.test.ts` (7 snapshot mismatches
  — committed `base.ts` lacks the Google-Fonts link the committed snapshots expect;
  both file and snapshots unmodified in the working tree and untouched by me →
  pre-existing at HEAD). An earlier mid-run also flaked 2 chat-routes smartModel tests
  while a concurrent task was editing shared prompt files; the full chat routes suite
  passes 185/185 in isolation on the current tree.
- `turbo typecheck --filter=@hushbox/api` — 6 errors, **all** in
  `slices/conversations/domain/budgets.ts` / `budgets.integration.test.ts` — files
  modified in the working tree by a concurrent lane, untouched by me.
  `--filter=@hushbox/shared` — pass.
- `turbo lint --filter=@hushbox/shared` — pass. `--filter=@hushbox/api` — pass.
- `eslint <every owned file>` run from `apps/api/` and `packages/shared/` after the
  final edit — exit 0.

## Acceptance criteria

1. Normalize applies ceil markup to every pricing rate (flat + matrix), stamps
   `version: '2'` — **met** (single `bakeFees` choke point; fee-baking describe +
   re-pinned billable rates across all families; version stamped in content by
   normalize).
2. Catalog read path fail-fasts on `version: '1'` with a clear error — **met**
   (`listDescriptors`, the single product read choke point; typed `unavailable` error
   naming row, found version, expected version, and the refresh remedy; pinned by
   integration test as an error, never a skip).
3. Ceil-markup helper beside `applyMarkup` in shared money.ts; half-even reserved for
   the port — **met** (`applyMarkupCeil`; port conversion untouched).

## Deviations

- `refresh.ts` is not on the Files list ("normalize.ts, catalog store read path,
  money.ts, tests") but needed two forced edits: with `version` moved into
  `DescriptorContent` (criterion 1 says *normalize* stamps it), the skip-unchanged
  compare had to stop filtering `version`, and the in-memory latest row's `version:
  '1'` literal had to go. Both are the catalog store's write-path plumbing; leaving
  them would have made every refresh rewrite every row every hour (hash never matches)
  and left a wrong literal.
- Read-path scope choice: the fail-fast lives in `listDescriptors` (product read), NOT
  in `readLatestDescriptorRows`, because refresh reads through the latter and must be
  able to see v1 rows to re-bake them (the plan's own recovery story). The admin read
  (`admin-catalog.ts`) deliberately keeps its show-everything-including-corrupt
  behavior (its documented purpose; it serves identity/status, never pricing) — a v1
  row is visible there while the product read refuses. Flagged for the auditor rather
  than silently narrowing the admin surface.

## Concerns / limitations

- Until T03, the shared estimator marks up already-billable rates (double markup on
  estimates only — over-reservation, plan-sequenced).
- Live/local DBs with existing v1 rows will fail-fast on every product catalog read
  until `catalog:refresh` (or `db:reset`) runs — designed behavior per the zero-users
  ruling; the re-bake integration test proves refresh rewrites v1 rows in place.
  Seeds do not embed descriptors (`scripts/lib/e2e-models.ts` only validates stored
  rows; `seed-crypto.json` is user-crypto material), so no seed regeneration was
  needed.
- `chat/routes.integration.test.ts` received 4 one-line version bumps while T10
  concurrently owns other lines of that file — textual-merge hazard for the
  orchestrator to sequence.

## Confidence

High — every criterion is pinned by a test watched red first; all owned suites and the
full api run (minus one attributed pre-existing failure) are green; remaining failures
reproduce on files I never touched.
