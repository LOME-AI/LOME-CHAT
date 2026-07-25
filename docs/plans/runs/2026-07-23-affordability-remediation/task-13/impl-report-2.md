# Task 13 — fix round 2 (validated audit findings) — impl report 2

## Objective

Fix the five validated findings on Task 13. All are comment-truth /
test-pin-truth items — the shipped behavior was verified correct by two
auditors, and the contested finding was downgraded by the validator (A14: no
change to `pickEffortClassifier` or any pricing-selection logic). No production
logic changed in this round; the only behavioral artifact touched is one unit
test, replaced with a discriminating fixture.

## Files changed

- `apps/api/src/slices/chat/routes.ts` — `pinnedAutoDefinitionOrNull` docstring:
  the deleted placeholder resolution replaced by what the fallback actually does.
- `apps/api/src/slices/models/domain/smart-model-candidates.ts` —
  `pickEffortClassifier` docstring: `null` no longer described as a fallback to a
  placeholder resolution; it is the typed refusal. COMMENT ONLY — the selection
  logic is untouched per A14.
- `apps/api/src/slices/chat/domain/smart-model-turn.ts` — docblock placement
  only: the `answerMaxOutputTokens` docblock moved from above
  `tightestCompletionCap` to above `answerMaxOutputTokens`; `tightestCompletionCap`
  keeps its own (correct) docblock.
- `apps/api/src/slices/chat/domain/smart-model-turn.test.ts` — the false-rationale
  pin replaced by a discriminating fixture (see below); the surviving cap test's
  assertion strengthened from `> high` to `> max` so the strongest-rung coverage
  property stays pinned after the replacement.
- `apps/api/src/slices/chat/domain/turn-reasoning.ts` — two "(G3)" plan-section
  labels removed (durable naming).
- `apps/api/src/slices/chat/domain/turn-definition.integration.test.ts` — "(G3)"
  removed from one test name.

## Final text of each reworded comment

**`routes.ts` (`pinnedAutoDefinitionOrNull`), last two lines:**

```
 * carries no tool loop), and a non-eligible model falls back, where `auto`
 * resolves deterministically (the sole real choice) or reasoning-free, with
 * no classifier call, charge, or reserve.
```

**`smart-model-candidates.ts` (`pickEffortClassifier`), last three lines:**

```
 * uses. `null` when no text model can price the call; the caller refuses the
 * send with the typed classifier-unavailable code rather than picking an
 * effort itself.
```

**`turn-reasoning.ts:210`:**

```
/** A single model's entry for an explicit level — run as asked or refuse. */
```

**`turn-reasoning.ts:228` (bullet in `resolveTurnReasoning`'s docblock):**

```
 * - single model → run as asked or refuse: an explicit level the model
 *   does not offer is a typed validation error (a client-facing 400), never
 *   silently downgraded; …
```

**`turn-definition.integration.test.ts:343` (test name):**

```
'keeps the single-model explicit refusal: an unoffered level still 400s'
```

## Finding 2 — disposition: DISCRIMINATING FIXTURE (the preferred option)

The false claim ("the old fixed walk under-reserved") is gone entirely; no
restatement of it exists anywhere. The replacement test states only what is
true — the walk runs the model's own offered budgets, not a fixed level list —
and its fixture makes the two walks differ in OUTCOME, not just in rationale:

```ts
it('walks the model’s own offered budgets, not a fixed level list', () => {
  // A context this tight clamps every rung from Low upward to the whole
  // window, so none of them leaves answer headroom; Lite's 2048 is the only
  // budget that still fits. Walking the model's real options finds it — a
  // walk over a fixed High/Medium/Low list sees only the clamped rungs and
  // abandons the turn to the fallback path.
  const tight = reasoningDescriptor('tight-context-model', 2n, 3n, 3400);
  const definition = builtDefinition([tight, cheapText], 'tight-context-model', budget);
  const node = definition.nodes[0];
  const cap = node?.type === 'smartModel' ? node.params['maxOutputTokens'] : undefined;
  expect(cap as number).toBeGreaterThanOrEqual(REASONING_BUDGET_TOKENS_BY_EFFORT.lite);
});
```

Why it discriminates (mechanism, not coincidence): `clampBudget`
(`packages/shared/src/estimate/reasoning-plan.ts:198-204`) clamps every rung's
budget to the model's context, so at a 3400-token context Low/Medium/High/Max
all collapse to 3400 and `answerHeadroomTokens` returns undefined for each
(`totalOutputCeiling − B < 1`). Lite's 2048 is below the clamp and still leaves
headroom. Lite is reachable only through the full ladder, which the fixed
`['high','medium','low']` list never visits.

**Red evidence.** With the shipped walk the new test passes. The fixed walk was
then restored verbatim in `autoEffortAnswerCap` (the exact deleted body, with
`reasoningEntryFor` re-imported), and the test failed for exactly the intended
reason:

```
FAIL src/slices/chat/domain/smart-model-turn.test.ts > compileAutoEffortTurn
     (pinned model + auto effort) > walks the model’s own offered budgets, not a fixed level list
Error: expected a built turn, got 'fallback'
```

The file was then restored from a pre-edit copy; `grep -c reasoningEntryFor
apps/api/src/slices/chat/domain/smart-model-turn.ts` → 0, and the whole file
re-ran green (39/39). No temporary code remains.

The deleted pin's only true content — the cap covers the strongest offered rung
— was preserved by strengthening the surviving cap test's assertion on the same
rich fixture from `> REASONING_BUDGET_TOKENS_BY_EFFORT.high` to `> …max`
(strictly stronger; passes).

## "(G3)" grep proof

- Added-lines sweep over the whole run diff:
  `git diff HEAD -- apps/api/src packages/shared/src apps/web/src | grep -c '^+.*\bG3\b'` → **0**
  (no plan-section label is introduced by this run anywhere).
- Removed-lines sweep, same diff: `grep -c '^-.*\bG3\b'` → **0** — I deleted no
  pre-existing G3 line, i.e. `routes.ts:613,617`, `turn-definition.ts:436,887,903`,
  `turn-definition.test.ts:1192`, `turn-reasoning.ts:56`, `use-prompt-budget.ts:285`
  and the `packages/shared` sites are untouched (they remain in a repo-wide grep,
  which is the expected state per the orchestrator ruling).
- No other plan/task/section label (`T13`, `A12`, `G#`, "spike") was introduced.

## Self-gate

- `pnpm test:watch apps/api/src/slices/chat/domain/smart-model-turn.test.ts` —
  **pass, 39/39**.
- `pnpm test:watch apps/api/src/slices/chat/domain/turn-definition.integration.test.ts` —
  **pass, 13/13**.
- `pnpm test:watch apps/api/src/slices/chat/routes.integration.test.ts` —
  **pass, 187/187** (the file whose docstring changed).
- `vitest run` (apps/api) over `smart-model-turn.test.ts`,
  `turn-reasoning.test.ts`, `smart-model-candidates.test.ts` — **87 passed**.
- `npx tsc --noEmit` in `apps/api` — **exit 0**.
- `npx eslint <the six touched files>` from `apps/api`, run after the final
  edit — **exit 0** (no warnings, no prettier findings).

## Acceptance criteria (the five validated findings)

1. `routes.ts:681` placeholder-style docstring — **met**; reworded to the actual
   fallback behavior (deterministic sole choice, else reasoning-free).
2. `smart-model-turn.test.ts` false pin rationale — **met**; replaced by a
   truthful statement plus a fixture that the old walk fails (red evidence above).
3. `smart-model-candidates.ts:172-173` docstring — **met**; comment only, no
   selection-logic change (A14 honoured).
4. `smart-model-turn.ts:92-114` stranded docblock — **met**; each function now
   carries exactly one, correct docblock.
5. Three "(G3)" labels — **met**; grep proof above, pre-existing sites untouched.

## Deviations

- One edit beyond the literal findings, inside an owned file: the surviving cap
  test's assertion strengthened from `> high` to `> max`. Without it, replacing
  the deleted test would have silently dropped the (true) strongest-rung
  coverage property from the suite. Same fixture, strictly stronger assertion.

## Concerns and limitations

- **Pre-existing stale clause, deliberately NOT touched.** The moved
  `answerMaxOutputTokens` docblock ends "…or when the post-reserve budget covers
  the remaining context (the model default applies)". That is no longer true —
  the function always stamps a concrete ceiling in that branch. The
  concrete-stamp fallback predates T13 (`git diff HEAD` shows T13 only added the
  completion-cap clamp inside it), so it is not this task's line and my brief
  scoped this file to placement only. Raising it rather than editing it.
- The full `pnpm test:api` package run was not repeated this round: no
  production logic changed (comments plus one unit test), and the three affected
  test files plus the api typecheck are green. If the auditor wants the coverage
  gate re-run, the touched-file coverage is unchanged or better — the new
  fixture exercises the `autoEffortAnswerCap` loop's continue-then-succeed path,
  which the replaced test did not.

## Confidence

High. Every change is a comment or a test; the one test swap is backed by a
verified red against the restored old walk, and the discriminating mechanism is
grounded in `clampBudget`'s behavior rather than in tuned constants.
