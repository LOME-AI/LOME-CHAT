# C5 — impl report 2 (fix cycle)

## Objective

Close three validated findings. No behaviour change: the implementation from report 1 is
not reopened, and the `!someLevelFits` arm keeps its outcome. One test-only file changed.

1. Pin the zero-coverage `!someLevelFits` arm (`smart-model-turn.ts:456`) with a fixture
   whose fitted cap sits between the minimum-answer floor and the lowest rung's budget.
2. Correct report 1's factually wrong justification for dropping that arm's nominal pin.
3. Restate the "1–3 of ~190 models" figure as a per-basis band, not a catalog property.

## Files changed

| File                                                       | Why                                                                                                   |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `apps/api/src/slices/chat/domain/smart-model-turn.test.ts` | The three-outcome fixture that pins the ladder arm and brackets it. Nothing else in the repo changed. |

`smart-model-turn.ts` was mutated once, deliberately, for the discrimination check below and
restored from a byte-exact copy (`diff` clean, verbatim below). It is otherwise untouched by
this cycle.

## Finding 1 — the arm is pinned

### The fixture, numerically

All three cases share the trial policy (`TRIAL_TURN_HOOKS`), the fixed 1¢ per-message
ceiling as free funding (`10,000,000` nano), a 40-character prompt (20 input tokens), and a
`trial/engine` row at 1 nano/token in and out — the cheapest priceable row, so
`pickEffortClassifier` selects the same engine in all three (verified: the built case's node
carries `classifierModelId: 'trial/engine'`). Only the answer model's **output rate** moves.

The answer model is `supportedEfforts: null` with a 1,000,000-token context, so it offers
the full five-rung ladder at unclamped budgets:

| rung   | reasoning budget | fitted cap `someLevelFits` needs (`budget + MINIMUM_OUTPUT_TOKENS`) |
| ------ | ---------------- | ------------------------------------------------------------------- |
| lite   | 2,048            | **3,048**                                                           |
| low    | 4,096            | 5,096                                                               |
| medium | 12,288           | 13,288                                                              |
| high   | 32,768           | 33,768                                                              |
| max    | 65,536           | 66,536                                                              |

`MINIMUM_OUTPUT_TOKENS` = 1,000; the physical room is 999,980 tokens in every case, so the
fitted cap is decided by money alone.

| output rate          | fitted answer cap          | `withinFunds` | outcome        | why                                                                                 |
| -------------------- | -------------------------- | ------------- | -------------- | ----------------------------------------------------------------------------------- |
| 3,000 nano/token     | 3,331                      | true          | `built`        | 3,331 ≥ 3,048, so the cheapest rung fits                                            |
| **4,000 nano/token** | **2,498**                  | **true**      | **`fallback`** | **1,000 ≤ 2,498 < 3,048 — past the minimum-answer floor, short of the lowest rung** |
| 10,000 nano/token    | (floor 1,000 unaffordable) | false         | `unaffordable` | line 455 refuses before the ladder is consulted                                     |

The bracket the task asked for: the pinned fixture's fitted cap **2,498** sits strictly
between the minimum-answer floor **1,000** and the lowest rung's requirement **3,048**
(lite's 2,048-token budget plus that same floor). The next rung up needs 5,096.

The fitted caps were measured by replaying the compiler's own fit
(`turnModelPricings` → `sharedAnswerCeiling` → `buildSmartModelTurn` → `withStorageStamp` →
`fitAnswerCapToCeiling`) in a scratch harness that was deleted afterwards. The committed
tests assert **outcomes**, never a replayed number — reassembling the build inside the test
would re-derive the sizing the test exists to check.

### Tests added

| Name                                                                      | Behaviour                                                                                               | What it pins                                                                                                                              |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `falls back when the fitted cap buys no offered rung`                     | 4,000 nano/token ⇒ `{ kind: 'fallback' }`                                                               | the `!someLevelFits` arm itself                                                                                                           |
| `builds the classified turn once the fitted cap covers the cheapest rung` | 3,000 nano/token ⇒ `built`, node cap ≥ `REASONING_BUDGET_TOKENS_BY_EFFORT.lite + MINIMUM_OUTPUT_TOKENS` | that no earlier exit fires on this fixture (they are all rate-independent), and that the boundary is the lowest rung                      |
| `reports unaffordable when the cap cannot reach the minimum answer`       | 10,000 nano/token ⇒ `{ kind: 'unaffordable' }`                                                          | that the funds check (line 455) is a different outcome on the same fixture, so the middle case's `fallback` is not the funds check firing |

The three are one fixture on one axis. That ordering is what makes the middle case
attributable: the earlier exits (unknown model 400, `< 2` real choices 403, no priceable
classifier 407, unpriceable model 417) cannot depend on the output rate, and the `built`
neighbour shows none of them fires here.

### Branch coverage on line 456 — before and after

Measured with `--coverage.include` on `smart-model-turn.ts` alone, its own
`reportsDirectory`, over the two test files that drive this compiler (nothing else in
`apps/api` references `compileAutoEffortTurn` / `buildAutoEffortTurnDefinition`:
`smart-model-turn.test.ts` and `routes.ts` via `routes.integration.test.ts`). Counts read
out of `coverage-final.json` as `[taken, not-taken]`.

|        | tests      | `b` at line 456 | file branch %  | v8 uncovered list |
| ------ | ---------- | --------------- | -------------- | ----------------- |
| before | 250 passed | **`[0, 11]`**   | 89.18% (66/74) | `…05,319,456-548` |
| after  | 253 passed | **`[1, 12]`**   | 90.54% (67/74) | `…05,319,542-548` |

The same flip on the unit file alone: `[0, 8]` → `[1, 9]`. Line 456 leaves the uncovered
list; the taken-count goes from zero to one. Line 455's arm moves `[3, 11] → [4, 13]` — the
new `unaffordable` case — and no other branch's taken-count falls.

### The pin discriminates (mutation check)

With no background suite in flight, the arm's outcome was flipped in source to
`return ok({ kind: 'unaffordable' })` and the three pins re-run:

```
 FAIL  |api| src/slices/chat/domain/smart-model-turn.test.ts > compileAutoEffortTurn on the trial policy > the fitted cap measured against the model’s own rung ladder > falls back when the fitted cap buys no offered rung
AssertionError: expected { kind: 'unaffordable' } to deeply equal { kind: 'fallback' }
- Expected
+ Received
-   "kind": "fallback",
+   "kind": "unaffordable",
 Tests  1 failed | 2 passed | 51 skipped (54)
```

Exactly the intended test flipped, for the intended reason, and the other two held (they do
not read that arm). Source restored from the pre-mutation copy: `diff` reports no
difference, and line 456 reads `return ok({ kind: 'fallback' })` again.

## Finding 2 — the corrected reading, stated for citation

Report 1 §_Tests inverted or removed_ wrote:

> The ladder-check `fallback` arm keeps its own coverage through the Min-only,
> mandatory-single-level, capless and non-reasoning cases.

**That is false, and a later task must not cite it.** All four of those cases return from an
**earlier** guard and never reach line 456:

| case                              | returns at                                                                                           | measured taken-count |
| --------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------- |
| Min-only model                    | `turnEffortOptions(...).length < 2`, line 403                                                        | b[27] = 3            |
| single-level mandatory ladder     | same guard, line 403                                                                                 | (same branch)        |
| non-reasoning model               | same guard, line 403 (empty option set)                                                              | (same branch)        |
| capless model (`limits: {}`)      | `pricings === undefined`, line 417 — `turnModelPricings` returns undefined without a `contextLength` | b[29] = 1            |
| (unknown model, for completeness) | line 400                                                                                             | b[26] = 1            |

The measured taken-count for line 456 before this cycle was **zero** (table above). So the
inverted test's subject had **no surviving pin at all** — the removal left the arm
unmeasured, and the justification cited artifacts that exist and run but do not exercise the
line they were offered as covering. Same shape as the run's _existence cited is not
discrimination_ rule, applied correctly elsewhere in that same report and missed here.

## Finding 3 — the "1–3 of ~190 models" figure, restated

Report 1 §_Accepted costs_ stated "1–3 of ~190 trial-eligible models drop below the gate" as
though it were a catalog property. **It is not**; the plan is already corrected, and this is
the corrected wording for the record:

> The new refusal fires only where the classifier reserve exceeds the slack the pre-existing
> model gate already left. That needs **both** a low output rate **and** a prompt whose own
> input cost already sits within the reserve of the ceiling. **For ordinary prompts the
> newly-refused set is empty**; it grows with very long resent histories. It is therefore a
> **per-basis band**, measured against a given prompt basis — not an invariant and not a
> count of models. The direction is conservative (the gate refuses more, never less).

Nothing about the ~0.05¢ absorbed per trial turn changes.

## Self-gate

| Command                                                                                                | Result                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm test:watch run …/smart-model-turn.test.ts`                                                       | pass — 54/54 (was 51)                                                                                                                                                                                                                                                                                                                |
| `pnpm test:watch run …/smart-model-turn.test.ts …/routes.integration.test.ts` (the after-coverage run) | pass — 253/253                                                                                                                                                                                                                                                                                                                       |
| scoped coverage on `smart-model-turn.ts`, own reports directory                                        | branch 89.18% → 90.54%; line 456 covered. Exit 1 on the 95% threshold, because this two-file scope does not drive the whole file (the DB-backed builders live in other suites) — not a regression: the change is test-only and no branch lost a hit.                                                                                 |
| `npx eslint src/slices/chat/domain/smart-model-turn.test.ts` from `apps/api`, after the last edit      | **exit 0**, no output                                                                                                                                                                                                                                                                                                                |
| `npx tsc --noEmit -p tsconfig.json` from `apps/api`                                                    | exit 2 — **4 errors, none mine**: `turn-context.integration.test.ts` and `turn-definition.integration.test.ts` missing the new required `minTurnCost` on `resolveTurnContext`'s argument. That contract is a concurrent workstream's in-flight edit to `turn-context.ts` (mtime during my run); zero errors name any file I touched. |

`pnpm test:api` and `pnpm ensure-stack` were not run, per the brief.

### Failures observed and attributed outward

- **Chat-slice run at 14:16 (before any edit of mine): 2 failed** — both
  `regenerate.integration.test.ts > replays a retried regenerate under the same run key …`
  (`expected 'failed' to be 'succeeded'`). This is verbatim one of the four failures §Known
  Breakage names as the moving-set chat-integration flake; the tree held zero edits of mine
  at that moment.
- **Paired run at ~14:21: 106 failed**, all in `routes.integration.test.ts`, all
  `TypeError: Cannot read properties of undefined (reading 'kind')` at
  `chat/domain/turn-context.ts:146` (`comparableNanoUsd`) via `routes.ts:1141`. The two
  files' mtimes moved to 14:20:18 and 14:21:07 — during the run. The identical command on
  the identical suite was **250/250 green at ~14:14** and **253/253 green at ~14:23**. A
  concurrent workstream's in-flight edit, not mine.
- **Chat-slice run at 14:24 (after the pin): 12 failed, all 24 FAIL lines in
  `turn-context.test.ts`** (`Called _unsafeUnwrapErr on an Ok`) — the same workstream's file.
  Because vitest suppresses the coverage report when any test fails, a slice-wide coverage
  number for `smart-model-turn.ts` was **not obtainable** in this window; the two-file scope
  above is what the branch evidence rests on, and it is the scope that contains every driver
  of the function.

## Deviations

None. No source behaviour changed, no file outside the one test file was edited, and the
arm's outcome is exactly as report 1 left it.

## Concerns and limitations

- **The fixture is calibrated against today's lite rung (2,048).** The per-label budgets are
  founder-tunable data. If lite were retuned below ~1,498, this fixture's 2,498-token cap
  would start clearing the lowest rung and the `fallback` pin would go red. That is the pin
  behaving correctly — a tuning change moving this arm is exactly what it should surface —
  but the reader who sees it red should re-place the fixture rather than delete the test.
- **Slice-wide coverage for `smart-model-turn.ts` is unmeasured in this cycle**, for the
  concurrent-red reason above. Report 1's slice-wide figure (100 / 98.64 / 100 / 100) was
  taken before this change; a test-only addition that flips one branch from 0 to 1 hit
  cannot lower it.
- **The arm's correctness is still open and is not mine.** Whether abandoning the classifier
  when no rung is affordable is a banned static fallback or a permitted deterministic
  single-choice pick is being ruled once for both paths elsewhere; the pin exists so that
  ruling lands against a measured, stable outcome. The committed comment says exactly that,
  without naming any task.

## Confidence

**High.** The pinned arm's branch taken-count is measured at zero before and one after, on
the same command over the same two files, with the line leaving v8's uncovered list; the pin
was shown to flip — alone, and for the right reason — under a deliberate mutation of that one
arm, with the source restored byte-exactly; the bracket is stated in tokens against the
shared constants the compiler itself reads; and every failure in the tree is attributed to a
named concurrent file with mtime and stack evidence, none of it in anything I touched.
