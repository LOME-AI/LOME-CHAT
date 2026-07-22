# Task-06 impl-report-3 — Phase-4 close: per-file branch-coverage fix

## Objective

Fix two validated Phase-4 close findings: per-file BRANCH-coverage shortfalls (< 95%) on
two estimator-modified web files. Test-only — no production logic changed.

- `apps/web/src/components/chat/model-selector/model-info-panel.tsx` — branches 92.85% → target ≥95%
- `apps/web/src/components/chat/model-selector/model-selector-helpers.ts` — branches 92.68% → target ≥95%

## Branches covered

### model-selector-helpers.ts (uncovered lines 42, 45, 59, 123, 138)
- **L42** `priceSortKey` text: `model.pricing.inputPerToken ?? '0'` fallback — text model with no `inputPerToken` sorted by price (key → 0n). This call also drives `compareBigint` with `a < b` (returns `-1`), the previously-unhit comparison branch (reported at L59/L58).
- **L45** `priceSortKey` image: `model.pricing.perImage ?? '0'` fallback — image model with empty pricing sorted by price.
- **L123** `interlaceModels` loop: `if (basicModel)` false branch — premium outnumbers basic in the non-`surfaceAvailableFirst` path, so a basic slot is absent and skipped. (The pre-existing "premium outnumbers basic" test only hit the `zipAvailableFirst` path, not this loop.)
- **L138** `modelSubtitle` image: `model.pricing.perImage ?? '0'` fallback — image model with empty pricing renders `$0.000/image`.

### model-info-panel.tsx (uncovered lines 122–126, 161, 184)
- **L122 / L126 / L130–132** `TextStandardPanel`: `inputPerToken ?? '0'` and `outputPerToken ?? '0'` fallbacks on both displayed rates and the `isExpensiveModelNano` check — text model with empty pricing.
- **L161** `ImagePanel`: `perImage ?? '0'` fallback — image model with empty pricing renders `$0.000/image`.
- **L184** `VideoPanel`: `perSecondByResolution ?? {}` fallback — video model with empty pricing renders the resolution table with no rows.

## Tests added

`model-selector-helpers.test.ts`:
- `sortModels` › "treats a text model with no input rate as zero-priced" — asserts `['a','b']` order (missing rate sorts cheapest). Covers L42 + `compareBigint` `a<b` branch.
- `sortModels` › "treats an image model with no per-image rate as zero-priced" — asserts `['b','a']`. Covers L45.
- `interlaceModels` › "appends trailing premium models when premium outnumbers basic" — asserts `['b1','p1','p2']`. Covers L123 false branch.
- `modelSubtitle` › "shows a zero per-image price when an image model omits its rate" — asserts `'Acme • $0.000/image'`. Covers L138.

`model-info-panel.test.tsx`:
- full mode › "renders zero token prices when a text model omits its rates" — asserts two `$0 / 1k` values, no expensive warning. Covers L122/L126/L130–132.
- image modality › "renders a zero per-image price when the rate is omitted" — asserts `$0.000/image`. Covers L161.
- video modality › "renders the resolution table with no rows when pricing is omitted" — asserts headers present, `720p` absent. Covers L184.

All assert real rendered/returned values (verified `nanoPricePer1k(0n)='$0'`, `nanoUnitPriceUsd(0n,3)='$0.000'` against the shared formatter), not mere execution.

## Self-gate

Scoped coverage command (full `test:web` merge avoided — it OOMs per the brief):

```
cd apps/web && npx tsx ../../scripts/with-env.ts vitest run --coverage \
  --coverage.include='src/components/chat/model-selector/model-selector-helpers.ts' \
  --coverage.include='src/components/chat/model-selector/model-info-panel.tsx' \
  src/components/chat/model-selector/model-selector-helpers.test.ts \
  src/components/chat/model-selector/model-info-panel.test.tsx
```

- **Result: pass** — 92 tests pass, no per-file threshold ERROR. Branch coverage:
  - `model-info-panel.tsx`: 92.85% → **100%** (56/56) — verified in an isolated single-file run.
  - `model-selector-helpers.ts`: 92.68% → **98.78%** (only remaining uncovered branch is L15, unrelated to this task's findings and above the 95% gate).
  - All-files branch for the two: 99.27%.
- **eslint** `model-selector-helpers.test.ts` + `model-info-panel.test.tsx` (from `apps/web`) — **pass (exit 0)** after a prettier line-wrap fix.

## Acceptance criteria

- model-info-panel.tsx branch ≥95% — **met** (100%).
- model-selector-helpers.ts branch ≥95% — **met** (98.78%).
- No production `.tsx`/`.ts` logic changed — **met** (only the two `*.test.*` files edited).

## Deviations

None.

## Concerns and limitations

- Did not run the full `test:web` coverage merge (OOMs per brief); scoped per-file runs used instead, which is exactly what the per-file gate checks.
- Repo has an interactive rebase in progress (concurrent e2e-green run); I touched only my two test files.

## Confidence

High — coverage moved above the gate for both files with meaningful output assertions; lint clean.
