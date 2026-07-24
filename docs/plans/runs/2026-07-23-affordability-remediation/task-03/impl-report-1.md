# Task 03 — Shared estimator: billable-only refactor — impl report 1

## Objective

Remove all fee logic from `packages/shared/src/estimate/`; replace
`NanoLineItem.marksUp` with `kind: 'provider' | 'storage'`; reducers become pure
sums over billable rates; formatters become pure renderers; search-reservation
constant billable at definition; fix `pricing.ts` stale comment; absorb the
`smart-model-affordability.ts` branch-coverage shortfall (A1).

## Files changed

Shared (owned Files list):

- `packages/shared/src/estimate/types.ts` — `NanoLineItem.marksUp` → `kind: 'provider' | 'storage'`; docstrings say billable.
- `packages/shared/src/estimate/reducers.ts` — fold by `kind`; `evaluateManifest` selector renamed `{ scope: 'provider-only' | 'all-in' }`; `reservationCeiling` and `affordability` are pure sums (all `applyMarkup` calls deleted).
- `packages/shared/src/estimate/price-request.ts` — items carry `kind`; docstrings.
- `packages/shared/src/estimate/media-pricing.ts` — items carry `kind`; docstrings.
- `packages/shared/src/estimate/classifier-line-item.ts` — items carry `kind`; docstrings.
- `packages/shared/src/estimate/search-reservation.ts` — new `WEB_SEARCH_RESERVATION_NANO_PER_MODEL` billable at definition via `applyMarkupCeil` (fee baked once at module definition, mirroring catalog ingestion; value 57,500,000n = old reservation exactly); `webSearchLineItem` emits it as a `provider` item; `…_BASE_…` export retained transitionally for the api `WORST_CASE` constant (T04 deletes).
- `packages/shared/src/estimate/run-ceiling.ts` — `marksUpOnly()` → `providerOnly()` filtering `kind === 'provider'`; docstrings.
- `packages/shared/src/estimate/smart-model-affordability.ts` — `applyMarkup` import deleted; classifier reserve = provider item's own billable figure; `candidateCost` pure sum; classifier-storage ternary hoisted to statement position; docstrings; v8-ignore comments on 6 compiler-narrowing-only branches (byId lookups that cannot miss, guards on fields the priced pool guarantees), each with justification — matching the file's existing precedent.
- `packages/shared/src/estimate/format.ts` — `applyMarkup` deleted; all four formatters are pure renderers over billable wire rates; docstrings.
- `packages/shared/src/pricing.ts` — dead `pricingFromRawModel` comment replaced with "baked at catalog ingestion".
- `packages/shared/src/index.ts` — **(outside Files list, export-only)** one line adding `WEB_SEARCH_RESERVATION_NANO_PER_MODEL` to the estimate export block (needed by the web test re-pin).

Mechanical call-site renames outside the Files list (sanctioned by the brief via A3; no fee-application deletions made — those stay T04's):

- `apps/api/src/slices/models/domain/estimate.ts:95` — `{ marksUpOnly: true }` → `{ scope: 'provider-only' }`.
- `apps/api/src/slices/models/domain/estimate-run.ts:521` — `.filter(item => item.marksUp)` → `kind === 'provider'`.
- `apps/api/src/slices/models/domain/smart-model-candidates.ts:137` — `.find(item => item.marksUp)` → `kind === 'provider'`.
- `apps/api/src/slices/models/domain/trial-eligibility.ts:205` — `{ marksUpOnly: false }` → `{ scope: 'all-in' }`.
- `apps/web/src/hooks/billing/use-budget-calculation.ts:107-111` — selector renames (its `applyMarkup` fee line retained for T04).

Downstream test re-pins (expectations that reconstructed the double markup T03 deletes; behavior-tracking only, no production fee code touched):

- `apps/api/src/slices/models/domain/estimate.test.ts` — ceiling pin 124,200,000n → 108,000,000n (pure sum).
- `apps/api/src/slices/models/domain/estimate-run.test.ts` — 48 `applyMarkup(…)` wrappers stripped from expectations; import removed.
- `apps/api/src/slices/models/domain/smart-model-candidates.test.ts` — `classifierReserve` helper no longer marks up; the `pickEffortClassifier` pin keeps `applyMarkup` (that production path still applies it until T04) with a comment.
- `apps/api/src/slices/chat/domain/turn-definition.test.ts` — the two "shrinks cap to fit funds" tests pinned the pre-billable drift premise (`estimate(stamped) > spendable`), which is structurally impossible now (the sizing guess still marks rates up per-rate → strictly conservative vs the unmarked estimator); re-pinned to the surviving invariant (fitted ceiling ≤ funds, uniform sibling caps, `cap ≤ guess`).
- `apps/web/src/hooks/billing/use-budget-calculation.test.ts` — minCost blocks re-pinned as pure sums; web-search delta now pins the billable constant directly.
- `apps/web/src/hooks/billing/use-media-cost-estimate.test.ts` — `expectedCents` helper no longer marks up.
- `apps/web/src/components/chat/model-selector/model-selector-helpers.test.ts`, `model-info-panel.test.tsx`, `model-selector-modal.test.tsx` — display pins re-pinned to render billable rates as given ($0.023→$0.020/image, $0.58→$0.50/s, etc.).

## A3 sweep — every producer/consumer of marksUp / NanoLineItem / evaluateManifest options, repo-wide

Greps: `marksUp` (0 hits repo-wide after change), `NanoLineItem`, `evaluateManifest`, `WEB_SEARCH_RESERVATION`, incl. `scripts/`, `e2e/`, `apps/marketing` — the latter three have **zero** references (verified).

| # | Site | Role | Disposition |
|---|------|------|-------------|
| 1 | shared estimate/price-request.ts | producer (4 items) | kind fields (edited) |
| 2 | shared estimate/media-pricing.ts | producer (2) | kind fields (edited) |
| 3 | shared estimate/classifier-line-item.ts | producer (2) | kind fields (edited) |
| 4 | shared estimate/search-reservation.ts | producer (1) | kind + billable at definition (edited) |
| 5 | shared estimate/reducers.ts | consumer (fold) | kind + scope selector (edited) |
| 6 | shared estimate/run-ceiling.ts | consumer (filter) | providerOnly (edited) |
| 7 | shared estimate/smart-model-affordability.ts | consumer (find ×2) | kind (edited) |
| 8 | shared src/index.ts | re-export | + billable constant export |
| 9 | api models/domain/estimate.ts | consumer (evaluateManifest option) | mechanical rename |
| 10 | api models/domain/estimate-run.ts | consumer (filter) | mechanical rename |
| 11 | api models/domain/smart-model-candidates.ts | consumer (find) | mechanical rename |
| 12 | api models/domain/trial-eligibility.ts | consumer (evaluateManifest option) | mechanical rename |
| 13 | web hooks/billing/use-budget-calculation.ts | consumer (evaluateManifest ×4) | mechanical rename |
| 14 | shared estimate/*.test.ts (8 files) | test consumers | re-pinned under TDD |
| 15 | api estimate/estimate-run/smart-model-candidates/trial-smart-model-candidates/turn-definition tests | test consumers | re-pinned (double-markup reconstructions removed) |
| 16 | web billing-hook + model-selector tests (5 files) | test consumers | re-pinned |
| 17 | scripts/, e2e/, apps/marketing | — | zero references (grep) |

## Tests added

- `reducers.test.ts` "reserves at least the all-in bill for every output count up to the ceiling" — **the new over-reserve invariant pin**: `reservationCeiling ≥ evaluateManifest(all-in)` for all actual outputs ≤ ceiling (estimates ≥ settlement's billable charges; the manifest is billable, settlement charges billable).
- `reducers.test.ts` scope-selector tests (provider-only vs all-in) — red first (old fold misclassified kind items), green after.
- `search-reservation.test.ts` — billable constant = `applyMarkupCeil(base)` = 57,500,000n; line item billable, `kind: 'provider'`; guards.
- `smart-model-affordability.test.ts` — "prices the classifier reserve as the provider item's own billable figure" (red first: old code marked it up), plus coverage-driven real tests: empty-pool refusals for both entry points, floor-unpriceable candidate exclusion, context-consumed-by-prompt exclusion, no-stamped-prompt full-context cap, cramped-context null threshold, threshold ordering across ascending-rate candidates. Balance-sweep client/server parity tests kept passing **unchanged in structure** (criterion).
- `format.test.ts` — re-pinned as pure renderers (red first: old code marked up), incl. exact $0.10 threshold boundary.

## Self-gate

- `pnpm test:shared` — pass (2264/2264, per-file coverage gate green; `smart-model-affordability.ts` now 100% stmts/branch/funcs/lines, was 86.02% branch).
- `pnpm typecheck` (repo-wide, per A3) — pass (15/15 tasks, 0 errors).
- `turbo typecheck --filter=@hushbox/shared` — pass; `eslint` on every edited file, run from each package dir after the final edit — exit 0 (shared, api, web).
- `pnpm test:api` — 6090 passed, 7 failed, all 7 in `notifications/domain/templates/template-html.test.ts` (snapshot) — **pre-existing per Amendment A1**; that file imports only email templates, no estimator code, untouched by this task.
- `pnpm test:web` — pass (6010/6010, 364 files).
- Grep gates: `marksUp` — zero hits repo-wide; `applyMarkup` imports under `packages/shared/src/estimate/` — zero (only `applyMarkupCeil` at the search-reservation definition, see deviations).

## Acceptance criteria

- Zero `applyMarkup` imports under `packages/shared/src/estimate/` — **met** (grep evidence; `applyMarkupCeil` appears once, at constant definition — see deviation 1).
- `marksUp` → `kind`; `evaluateManifest` selector renamed provider-only/all-in; storage-dropping behavior pinned unchanged — **met** (`run-ceiling.ts` `providerOnly`, `estimate-run.ts:521` filter, NO_STORAGE paths pinned by existing tests, all green).
- `format.ts` renders without fee math; docstrings say billable — **met** (format.test.ts re-pinned red→green).
- Smart Model threshold/admission tests incl. balance-sweep parity green — **met** (28/28 in smart-model-affordability.test.ts; parity sweeps structurally unchanged; api smart-model integration tests green in full run).
- A1 absorption: smart-model-affordability.ts ≥95% — **met at 100%** (real tests for every reachable branch; 6 documented v8-ignores for compiler-narrowing-only branches — see deviation 4).

## Deviations (with reasons)

1. **`applyMarkupCeil` at definition in `search-reservation.ts`.** "Billable at definition" needs a one-time bake; `SEARCH_COST_PER_CALL` is a raw provider figure and `constants.ts`/`money.ts` are outside my Files list. Baked at module definition (never at estimate time), ceil per the ingestion rule; value identical to the old reservation (57.5M nano exactly, no rounding drift). **Conflicts with T05's planned seam allowlist** (money.ts, normalize, port conversion, backfill) — T05 must allowlist this definition-time seam or the constant must hoist to money.ts.
2. **Transitional reservation < settlement window (T03→T04).** Admission holds now price billable (no markup) while `chargeWithinTx`/settlement still applies `applyMarkup` on already-billable bases until T04 — a hold can sit ~15% under the transitional double-marked charge. Plan-mandated sequencing (T02→T03→T04 lands as one body of work); negative balances are legal; cost circuit unaffected (hold×5). Flagged, not blocked.
3. **Out-of-Files-list edits**: one export line in `packages/shared/src/index.ts`; the five brief-sanctioned mechanical renames; downstream test re-pins in 5 api + 5 web test files whose expectations reconstructed the deleted double markup (required by "downstream callers keep compiling and their tests passing"). Zero production fee-application deletions made — T04's list is intact (`estimate.ts` WORST_CASE wrapper, `chargeWithinTx`, `turn-definition.ts:176-177`, `smart-model-candidates.ts:146`, `use-budget-calculation.ts:113` all still apply markup).
4. **v8-ignore on 6 branches** in smart-model-affordability.ts — all are undefined-narrowing on lookups/fields the priced pool guarantees (byId built from the same candidate list; priced ⊆ candidates; floor pricing requires ctx + both rates). Real tests cover every reachable branch; the ignores follow the file's pre-existing documented pattern.
5. **`WEB_SEARCH_RESERVATION_BASE_NANO_PER_MODEL` retained** (transitional) — sole production consumer is api `WORST_CASE_SEARCH_RESERVATION_NANO_USD = applyMarkup(base)`, still numerically equal to the billable constant; T04 deletes both wrapper and base export.
6. **turn-definition fit-test premise re-pinned** — the "guess over-reserves past funds" premise is unreproducible against billable rates (the transitional per-rate markup in `turnMaxOutputTokens` makes the guess strictly conservative); the surviving invariant (fitted ceiling ≤ funds) is pinned. T15 deletes the reconcile loop entirely.

## Concerns and limitations

- **Stale vite optimizer caches**: api/web vitest `optimizeDeps` pre-bundles `@hushbox/shared`; after the shared contract change, cached bundles silently ran the OLD reducer logic (all items classified storage). Cleared `node_modules/.vite`(+`-temp`) at repo root, apps/api, apps/web. Any concurrent lane running api/web tests against fresh shared changes may need the same.
- `use-budget-calculation.ts`'s reasoning-surcharge rate still applies `applyMarkup` (T04 file) — display-side over-estimate, safe direction, its own test pins the current production behavior.
- The `estimate-run.test.ts` header comments describing the historical drift class were left; the two rewritten tests carry current-state notes.

## Confidence

High — every criterion pinned red→green; full shared/web suites and repo typecheck clean; the single api failure is the A1-listed pre-existing snapshot flake in an unrelated file.
