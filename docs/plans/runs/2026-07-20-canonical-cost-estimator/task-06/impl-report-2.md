# T6 (fix pass 2) — Close calculate-cost branch-coverage gap + correct stale prompts.ts comment

## Objective
Fix the two orchestrator-validated findings from impl-report-1's blast radius, without changing
any logic or money value:
1. calculate-cost.ts branch coverage 83.33% (<95% per-file gate) — the `?? '0'` fallbacks on the
   cheapest model's `inputPerToken`/`outputPerToken` (lines 58-59) were never exercised.
2. prompts.ts:80 doc comment referenced `buildEligibleModels`, which T6 deleted.

## Files changed
- `apps/marketing/src/lib/calculate-cost.test.ts` — added two tests exercising both fallback
  branches (test only; no source/logic touched).
- `packages/shared/src/smart-model/prompts.ts` — corrected one doc-comment reference (comment only).

## Finding 1 — branch coverage

### Root diagnosis of the 83.33%
83.33% = 10/12 branch outcomes. The two uncovered outcomes were the FALLBACK path of `?? '0'` on
BOTH line 58 (`cheapest.pricing.inputPerToken ?? '0'`) and line 59 (`cheapest.pricing.outputPerToken
?? '0'`). Line 25's two fallbacks were already covered by the existing free-model (`pricing: {}`)
tests. A model can be "paid" (`combinedTokenRateNano > 0`) with only ONE token rate present, so each
fallback needs its own cheapest model. Covering only one (per the brief's example) reaches 11/12 =
91.67%, still under the gate — so both were needed.

### Tests added (TDD note)
Because the finding is a coverage gap on already-correct logic, the "red" is the coverage gate
(83.33% < 95%), not an assertion failure — the assertions pass against the existing correct behavior.
Each test asserts the missing-rate-as-zero behavior directly by equivalence to an explicit `'0'`:

```ts
it('treats a missing outputPerToken rate on the cheapest model as zero', () => {
  const missing = calculateMonthlyCost([makeModel({ pricing: { inputPerToken: '1000' } })]);
  const explicitZero = calculateMonthlyCost([
    makeModel({ pricing: { inputPerToken: '1000', outputPerToken: '0' } }),
  ]);
  expect(missing.monthlyCost).toBe(explicitZero.monthlyCost);   // covers line 59 fallback
  expect(missing.monthlyCost).toBeGreaterThan(0);
});

it('treats a missing inputPerToken rate on the cheapest model as zero', () => {
  const missing = calculateMonthlyCost([makeModel({ pricing: { outputPerToken: '2000' } })]);
  const explicitZero = calculateMonthlyCost([
    makeModel({ pricing: { inputPerToken: '0', outputPerToken: '2000' } }),
  ]);
  expect(missing.monthlyCost).toBe(explicitZero.monthlyCost);   // covers line 58 fallback
  expect(missing.monthlyCost).toBeGreaterThan(0);
});
```

The equivalence assertion (`missing === explicitZero`) is what pins "missing rate ⟺ zero" as the
current behavior — a stronger guard than a bare `> 0`.

### Coverage before → after (calculate-cost.ts)
- BEFORE: branch **83.33%** — `pnpm test` printed
  `ERROR: Coverage for branches (83.33%) does not meet ... threshold (95%) for src/lib/calculate-cost.ts`.
- AFTER: branch **100%** — the ERROR line is gone and calculate-cost.ts no longer appears in the
  reporter's <100% list (text reporter only lists files below 100%). All-files branch rose
  99.03% → 99.51%; marketing suite 450 → 452 tests, gate green. **≥95% proven.**

### Note on `?? '0'` (raised, NOT changed)
`?? '0'` treats a missing token rate as zero, which UNDERSTATES a paid model's per-message cost and
could rank such a model as "cheapest" on incomplete data. It is arguably wrong for a cost estimate.
However: (a) the brief forbids changing the logic/money values, and (b) it is pathological in
practice — OpenRouter text-priced models carry both input and output token rates, and a model with
neither is already filtered out as free. Flagged for the orchestrator; logic left as-is per brief.

## Finding 2 — stale comment
`computeClassifierPromptOverhead`'s doc block said it is "Used by `buildEligibleModels`". That
function was deleted in T6. Its surviving consumer is `classifierReserveChars` in
`packages/shared/src/estimate/classifier-line-item.ts` (verified: the only non-test caller of
`computeClassifierPromptOverhead`). The overhead is measured in characters, so "token / cost terms"
was also imprecise. Corrected to:

```
 * model list and an EMPTY truncated context. Used by `classifierReserveChars`
 * to size the worst-case classifier overhead in char terms without
 * relying on a guessed constant that can drift from the prompt template.
```

## Self-gate
- `cd apps/marketing && pnpm test` (coverage) — **PASS**: 50 files / 452 tests; no threshold ERROR;
  calculate-cost.ts branch 83.33% → 100% (the finding, proven).
- `pnpm test:shared` — **PASS**: 96 files / 2306 tests; prompts.ts 100/100/100/100.
- `turbo typecheck lint --filter=@hushbox/shared --filter=@hushbox/marketing` — **PASS**: 4/4 tasks,
  0 errors (a pre-existing `TrustCard.astro` ts(6196) hint is unrelated to this task).

## Acceptance criteria
- Finding 1 (branch coverage ≥95% on calculate-cost.ts) — **MET** (83.33% → 100%).
- Finding 2 (stale `buildEligibleModels` reference corrected) — **MET**.
- No logic or money value changed; no file outside bounds touched — **MET**.

## Deviations
Added TWO tests, not one — required to reach ≥95% (one fallback each; a single test tops out at
91.67%). Within bounds (calculate-cost.test.ts).

## Confidence
High. Coverage delta measured directly (ERROR gone, all-files branch up, gate green); comment
retargeted at the verified surviving consumer; all gates green.
