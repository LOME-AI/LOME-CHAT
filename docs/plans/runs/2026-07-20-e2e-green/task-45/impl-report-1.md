# Task-45 — Smart-Model answer cap must always be stamped (completes the chat-402 fix)

## Objective

Funded personas ($100) still hit 402 on Smart-Model sends because the admission
estimate was ~$217 (2.17× balance): `node.params.maxOutputTokens` was omitted whenever
the budget covered the tightest candidate's context, so the multi-candidate admission
estimator (`declaredOutputCeiling`) priced each candidate at its OWN full context and
took the MAX — the widest candidate (gpt-5.4-pro, 1,050,000 tokens) uncapped at the
priciest rate. Fix `answerMaxOutputTokens` to always return a concrete, tightest-context
bound so BOTH the admission estimate and the real provider request are bounded.

## Files changed

- `apps/api/src/slices/chat/domain/smart-model-turn.ts` — `answerMaxOutputTokens` now
  captures `turnMaxOutputTokens(...)` and, when it returns `undefined`, clamps to
  `Math.max(1, minContextLength − promptInputTokensFor(budget))` (the tightest
  candidate's remaining context) instead of returning `undefined`. Added a comment
  explaining WHY "no cap" is safe only for single-model turns. `minContextLength` was
  already in scope; `promptInputTokensFor` already imported. The pricings-missing early
  return (`return undefined`) is untouched (a defect/edge path, not the affordable case).
- `apps/api/src/slices/chat/domain/smart-model-turn.test.ts` — added the chat-402-fix
  describe block; updated two pre-existing `answerMaxOutputTokens` tests that encoded the
  old over-reservation (undefined) behavior.

No change to `budget.ts` `computeSafeMaxTokens`, `smart-model-candidates.ts`,
`estimate-run.ts`, or any settlement/ledger code. Money stays nano-USD `bigint`; the
clamp arithmetic is on plain token counts (ints), never on money.

## Tests added / changed (behavior — criterion)

- `returns a concrete cap bounded by the tightest candidate context` — wide (1,050,000) +
  tight (8000) catalog, $100 purchased budget → `answerMaxOutputTokens` returns a number
  (7900), `< TIGHT_CONTEXT`, `>= 1`. (AC1, AC5a)
- `stamps the answer cap into the built definition node params` — the paid-path definition
  (mirrors `compileSmartModelBuild`) has `node.params.maxOutputTokens = 7900`. (AC5a)
- `reserves ~$1, well under a $100 balance (not the ~$217 uncapped estimate)` — real
  estimator (`createEstimateRun`) over the built definition < balance and < $5. (AC5b)
- `reserves far less than the widest candidate full-context price` — widest full-context
  price > $100 (the bug), and `estimate × 20 < widestFullContext`. (AC5b)
- `still refuses a genuinely unaffordable wallet (builder affordability gate)` —
  `buildSmartModelCandidates` returns `null` at balance 1n. (brief: keep unaffordable-refuse)
- Updated `clamps to the tightest remaining context when the budget covers it` (was
  `returns undefined when the budget covers the tightest remaining context`) → now expects
  3900.
- Updated `clamps to the tightest remaining context even when the reserve leaves little`
  (was `omits the cap when the reserve leaves too little for the minimum output`) → now
  expects 3800 (see Deviations).

## Self-gate

- `pnpm test:watch smart-model-turn.test.ts` — pass (19/19).
- `pnpm test:watch estimate-run.test.ts + smart-model-candidates.test.ts` — pass (69/69).
- `eslint smart-model-turn.ts + .test.ts` (from apps/api) — pass (exit 0).
- `prettier --check` both edited files — pass.
- `tsc --noEmit -p apps/api/tsconfig.json` — pass (exit 0).

## RED → GREEN evidence (real numbers)

Same catalog (classifier 8000-ctx; wide/pro 1,050,000-ctx, output rate 200,000 nano/token),
$100 purchased budget:

- RED (before fix): `answerMaxOutputTokens` → `undefined`; admission estimate =
  **241,500,012,714 nanoUSD ($241.50)** > $100 → 402. (5 new/updated tests failed for the
  right reason — undefined cap / >$100 estimate.)
- GREEN (after fix): cap = **7900**; admission estimate = **1,817,012,714 nanoUSD ($1.82)**
  < $100. Provider request is capped at the same 7900 tokens (no under-reserve vs runtime).

## Acceptance criteria

- AC1 (`answerMaxOutputTokens` never returns undefined in the affordable case; clamp to
  `Math.max(1, minContextLength − promptInputTokensFor(budget))`; comment WHY) — met.
- AC5a (unit: concrete number bounded by tightest context + node.params stamped) — met.
- AC5b (admission-magnitude: estimate < balance, ~$1 order, materially less than widest
  full-context, via real estimator) — met ($1.82 vs $241.50).
- Proof scope (`test:api` slices smart-model-turn + estimate-run + candidates green) — met
  coverage-free; full `pnpm test:api` not run (see Concerns).

## Deviations with reasons

- The brief characterized the `undefined`→clamp case narrowly as "budget covers the
  tightest candidate's context." `turnMaxOutputTokens` also returns `undefined` in the
  `effective < minimumCost` (answer-unaffordable-at-worst-rates) case. My fix clamps in
  BOTH: distinguishing them would require reaching into `turn-definition.ts` internals
  (outside this task's one-function scope), and clamping is correct either way — the clamp
  is a token upper bound equal to the real provider cap, so it never under-reserves vs
  runtime, and a genuinely unaffordable wallet is still refused at admission (doctrine:
  "admission is the only balance gate"). The old `undefined`→full-context behavior in that
  case was the same over-reservation bug this task fixes, just at low balance.
  Consequence: the pre-existing test `omits the cap when the reserve leaves too little`
  now asserts the clamp (3800) instead of `undefined`, updated with a comment. The
  builder-gate refusal test (`buildSmartModelCandidates` → null) is added to keep the
  unaffordable-refuse guarantee the brief asked for.

## Concerns and limitations

- I ran the three directly-relevant suites coverage-free, not the full `pnpm test:api` and
  not the coverage gate. The source change is one function on one line + a fallback branch,
  both covered by new tests; no other slice imports `answerMaxOutputTokens`.
- Did not run e2e (per brief — orchestrator runs `pnpm e2e:fast smart-model.spec.ts`).

## Confidence

High — root cause empirically reproduced ($241.50 estimate) and the fix drops it to $1.82
with the provider request capped at the same bound; all scoped suites, lint, prettier, and
typecheck green.
