# impl-report-2 — task-13 fix: cover the `fitAnswerCapToCeiling` floor-at-1 branch

## Objective

Close a Minor test-only coverage gap: the `!fits(1)` floor-at-1 money-safety branch in
`fitAnswerCapToCeiling` (`apps/api/src/slices/chat/domain/turn-definition.ts:310`) was
untested. Add a unit test that forces the branch and asserts the fail-closed outcome. No
production logic change.

## Files changed

- `apps/api/src/slices/chat/domain/turn-definition.test.ts` — one added `it` in the existing
  `describe('regular turn answer cap fits payer funds via the ONE estimator')` block, plus a
  durable-fact comment pinning the fail-closed floor. Test file only; no production code touched.

## Test added

`floors the cap at 1 and stays over funds when even a one-token answer over-reserves`

Inputs that force even a 1-token answer over spendable:
- `wideResolver` (128k-context, tiny integer nano rates — the describe block's existing resolver).
- `brokeBudget = { promptCharacterCount: 400, funding: { remainingNanoUsd: 1n, kind: 'free' } }`.
  Free tier gets **no cushion** (`spendableFundsNanoUsd(balance, 'free') = balance + 0`,
  `packages/shared/src/estimate/pre-adapters.ts:77`), so `payerSpendableNanoUsd(brokeBudget) === 1n`.
  A one-token answer's estimator ceiling (input tokens + prompt storage + one output token +
  output-storage) is far above 1 nano-USD → `fits(1)` is false.
- Build a single-model turn with `guess = 1000`, storage-stamp it (`CHAT_TURN_HOOKS`), then
  `reconcileAnswerCeiling(stamped, wideResolver, brokeBudget, 1000)`.

## Fail-closed behavior asserted (quoted from the code)

turn-definition.ts:310 — `if (!fits(1)) return withAnswerCap(definition, 1);`
Doc comment (turn-definition.ts:293–296):
> "ceiling monotonic in cap, so binary search over `[1, guessCap]` returns largest fitting cap;
> even one-token answer over-reserves, cap floors 1 admission refuses run (the balance gate does
> its job) rather any silent under-reserve."

Assertions:
- `expect(modelCallCaps(fitted)[0]).toBe(1)` — the cap floored at the minimum.
- `expect(estimate(fitted)._unsafeUnwrap() > spendableBroke).toBe(true)` — the floored ceiling is
  STILL priced above the payer's funds, i.e. admission's balance gate refuses the run. This second
  assertion is what distinguishes the floor branch from a binary-search result of 1 (which would
  price ≤ spendable); together they uniquely identify the `!fits(1)` path.

## Self-gate

- `vitest run turn-definition.test.ts -t "floors the cap at 1"` — pass (1 passed, 65 skipped).
- `vitest run turn-definition.test.ts` (full file) — pass (66 passed).
- `eslint src/slices/chat/domain/turn-definition.test.ts` — exit 0.
- Coverage (v8, scoped to `turn-definition.ts`): full-file run no longer lists line 310 in the
  uncovered set (`Uncovered Line #s: 338, 664-800` — those covered by the api suite's other test
  files, e.g. smart-model-turn.test.ts). Per-file 95% thresholds "fail" only because a single test
  file cannot cover the whole source file in isolation — expected, not a regression.

## Coverage evidence that line 310 / the floor-at-1 branch is now covered

Statement-level v8 JSON, isolating the two line-310 statements (56 = the `if (!fits(1))` test,
57 = the `return withAnswerCap(definition, 1)` floor body):

- WITHOUT the new test (siblings `shrinks a single-model` + `shrinks a multi-model` only):
  `56:2, 57:0` — the floor body was never executed (0 hits).
- WITH the new test alone: `56:1, 57:1` — the floor body executes exactly once.

So statement 57 (the fail-closed floor) went 0 → 1 and is now covered by, and only by, the added test.

## Deviations

None.

## Concerns and limitations

- Per-file coverage thresholds can only be judged against the whole api test run
  (`pnpm test:api`), not this scoped single-file run; the scoped numbers here exist solely to prove
  line-310 statement 57 is now hit. Nothing in this fix affects the other tests.

## Confidence

High — production untouched; the branch condition is forced by first principles (free-tier
no-cushion, 1 nano-USD spendable), the floor outcome is asserted directly, and v8 statement
coverage confirms the previously-0-hit floor body now executes.
