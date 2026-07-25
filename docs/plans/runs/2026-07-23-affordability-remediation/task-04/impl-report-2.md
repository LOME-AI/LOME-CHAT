# Task 04 — fix cycle 2 — comment/test-text truth fixes

## Objective

Fix the five validated audit findings: stale PRE-MARKUP/BASE/UNMARKED basis
language in trial-eligibility.ts, trial-smart-model-candidates.ts, and
chat/routes.ts, plus the dangling billable-vs-raw comment in
smart-model.integration.test.ts. Zero production behavior changed — comments,
one doc-word rename in prose, and one added test assertion only.

## Files changed (path — why)

- `apps/api/src/slices/models/domain/trial-eligibility.ts` — header cost-basis
  block and the cap constant's docstring reworded to the billable (all-in)
  basis (findings 1a/1b/1c).
- `apps/api/src/slices/models/domain/trial-smart-model-candidates.ts` — the
  PRE-MARKUP/UNMARKED contrast paragraph, "base cost" in the keep-iff rule,
  and the two "base price" doc words reworded billable (findings 2/4).
- `apps/api/src/slices/chat/routes.ts` — the one trial-cap comment: "BASE
  cost" → "BILLABLE (all-in) cost" (finding 3).
- `apps/api/src/slices/workflows/engine/smart-model.integration.test.ts` —
  the dangling comment now has its assertion (finding 5, assert path chosen);
  `usdToNanoUsd` added to the shared import; the `inlineUsd ?? 0` coalescing
  hoisted to the declaration (`toBeGreaterThan(0)` subsumes the removed
  `toBeDefined()`), required because the added assertion pushed the callback
  over the lint complexity cap of 10.

## Final reworded text (evidence)

trial-eligibility.ts header (lines 22–31):

```
 * Cost basis, stated once (see also the route): the 1¢ cap compares BILLABLE
 * (all-in) cost — the same figure a paid send would be charged, never the
 * worst-case run ceiling. The per-send budget (`trialMessageBillableNanoUsd`)
 * is the billable model cost PLUS the pass-through R2 storage the send will
 * incur (legacy `calculateTrialBudget` included storage); storage is
 * pass-through by construction (it never marks up). The coarse
 * premium-classification leg (`exceedsMinimalAffordability`) folds the same
 * billable rates but prices no storage: it is a token-count heuristic over a
 * fixed synthetic exchange, with no real character count to size storage
 * against.
```

trial-eligibility.ts cap constant:

```
/** 1¢ in nano-USD (0.01 USD). The per-message and affordability caps compare
 * BILLABLE (all-in) cost against this. */
```

trial-smart-model-candidates.ts basis bullet (and the two doc words):

```
 * - Everything is BILLABLE (all-in) cost — the trial cap's basis (see
 *   `trial-eligibility.ts`) and the same basis the paid filter's classifier
 *   reserve gates a customer-facing balance with. Both the reserve and the
 *   per-message cost include their pass-through R2 STORAGE (tier `trial`),
 *   matching legacy `calculateTrialBudget`; storage is pass-through by
 *   construction (it never marks up).
 * - A candidate is kept iff
 *     classifier worst-case reserve + the ACTUAL message's billable cost ≤ 1¢,
```

- line 20: "sorted ascending by combined per-token billable rate,"
- line 61: "Eligible candidates whose send fits the cap, ascending by billable rate."

chat/routes.ts:

```
  // The actual message priced on a minimum basis (history + prompt tokens + a
  // fixed minimum output allocation), BILLABLE (all-in) cost against the 1¢ cap.
```

No comment narrates the migration; each states only the current durable fact.

## Assert-or-drop decision (finding 5): ASSERTED

The preferred option — it pins the port conversion direction. Diff (final):

```ts
    // The conversion is the only fee application: billable strictly exceeds
    // the raw nano conversion of the same figure.
    expect(providerUsdToBillableNanoUsd(inlineUsd)).toBeGreaterThan(usdToNanoUsd(inlineUsd));
```

Red check: first written inverted (`toBeLessThanOrEqual`) and run — failed
exactly there: `AssertionError: expected 1150 to be less than or equal to
1000` (smart-model.integration.test.ts:285), proving the assertion
discriminates (billable 1150n > raw 1000n on the deterministic mock's inline
cost). Then flipped to `toBeGreaterThan`; file green.

## Self-gate

- `pnpm test:watch apps/api/src/slices/workflows/engine/smart-model.integration.test.ts`
  (repo root) — pass, 2/2 tests, 1 file.
- `npx eslint` on all four files from `apps/api` AFTER the final edit
  (`eslint --fix` on the test file for prettier reflow, then plain `eslint`
  on all four) — exit 0.
- Grep proof: `grep -niE "pre-markup|UNMARKED|marked-up|base price|base cost|provider-base|BASE \("`
  over the four files — zero hits (exit 1).
- `npx tsc --noEmit` in apps/api — one error, NOT mine:
  `slices/notifications/adapters/push-composite.ts(34,13) TS2322` — the entire
  notifications slice is a concurrent lane's in-flight working-tree edit (git
  status evidence: ~10 modified notifications files, none in my file set, none
  touched by me). My four files produce no diagnostics.

## Acceptance criteria (findings → met)

1. trial-eligibility.ts :22–24 / :27–29 / :50–51 — met (text above; the
   `exceedsMinimalAffordability` sentence now states the billable fold and the
   surviving no-storage distinction).
2. trial-smart-model-candidates.ts :29–32 — met (both false halves replaced by
   the current fact: one billable basis shared with the paid filter).
3. chat/routes.ts :362–363 — met.
4. "base price" doc words (:20, :61) — met, reworded billable rate.
5. Test dangling comment — met via the preferred added assertion, red-checked.

## Deviations

- The test callback's `inlineUsd ?? 0` coalescing was hoisted to the
  declaration and `expect(inlineUsd).toBeDefined()` dropped (subsumed by
  `toBeGreaterThan(0)` on the coalesced value): forced by the lint
  `complexity: 10` cap once the new assertion's `??` operators landed; no
  assertion strength lost.

## Concerns and limitations

- The apps/api typecheck failure in the notifications slice belongs to a
  concurrent lane; if that lane finishes or reverts it clears on its own.

## Confidence

High — comments-only changes plus one red-checked assertion; file test green,
lint exit 0, grep-proof clean on all four files.
