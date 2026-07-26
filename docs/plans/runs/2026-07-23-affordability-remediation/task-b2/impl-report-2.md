# B2 — The dimension registry · impl-report-2 (fix cycle)

## Objective

Four validated findings from B2's two audits: the money-unit defect in the model dimension's
reserve contribution (ruled direction: a distinct rate-shaped `kind`), two dead exports, one
pin that cannot fail, and one wrong-mechanism comment on a money function. Nothing else in the
task was reopened.

## Files changed

| Path | Why |
| --- | --- |
| `dimensions/types.ts` | `DIMENSION_RESOURCES` gains `moneyPerToken`; `ReserveContribution` gains a `{ kind: 'moneyPerToken'; nanoUsdPerToken: bigint }` arm; both carry the unit distinction in prose, and `requirement`'s docblock names the rate unit. (F1) |
| `dimensions/derive.ts` | `reserveContribution` derives the new kind for `resource: 'moneyPerToken'`; `isNanoUsdResource` shares the bigint-comparison decision with `cheapestPresentedOption`; the bigint type-guard message no longer says "money". (F1) |
| `dimensions/model.ts` | `resource: 'moneyPerToken'`; the docblock now states WHY it is a rate (the amount needs a ceiling the registry does not have) instead of instructing a reader not to misuse it. (F1) |
| `dimensions/effort.ts` | Deleted `EffortOptionId` and `offeredEffortOptionIds`, plus the now-unused `CanonicalReasoningEffort` type import. (F2) |
| `dimensions/effort.test.ts` | Deleted the `offeredEffortOptionIds` describe block and its import. (F2) |
| `dimensions/derive.test.ts` | The money arm is now pinned on a genuine absolute-amount dimension (multi-option, worst-of); a new test pins the model dimension's rate kind. (F1) |
| `dimensions/re-partition.test.ts` | Replaced the unfalsifiable narrowing pin with one over a varying input; added the control that shows it constrains something. (F3) |
| `premium.ts` | The storage-drop comment now names the `kind === 'provider'` filter as the mechanism. (F4) |

No file outside `packages/shared/src/affordability/` was touched. F2's files
(`funding-decision.ts`, `client-billing.ts`) and F1's `use-prompt-budget.ts` were not opened.

## Finding 1 — the money-unit defect

**What changed.** `resource` is what a dimension's `requirement` is denominated in, so a rate is
a different resource, not a different flavour of `money`. `DIMENSION_RESOURCES` therefore gains
`moneyPerToken`, the model dimension declares it, and the derivation stays a pure
`(resource × costClass)` table — no new declared field, no per-dimension code, so criterion 4's
"derived, never declared" is intact.

`{ kind: 'money'; nanoUsd }` now means exactly what §Cost classes says: nano-USD out of
`spendable`. `{ kind: 'moneyPerToken'; nanoUsdPerToken }` is the model dimension's arm.

### The contract B3 will read — how a consumer turns a rate into money

`moneyPerToken` **is not a hold term and cannot be added to one.** There is no multiplication
that turns it into one either, and this is the part worth stating precisely:

- The rate is `inputRate(m) + outputRate(m)`, a single per-token number. A turn's cost is
  `cost(m, tokens) = inputTokens × inputRate(m) + tokens × variableRate(m)` — the input leg is
  sized by the **prompt**, the output leg by the **ceiling**, and `variableRate` carries storage
  when the turn persists. So `nanoUsdPerToken × ceilingTokens` is not `cost(m, ceilingTokens)`
  and must never be written as if it were.
- To obtain money, a consumer must hold what the registry does not: the prompt basis and the
  ceiling it is solving for. It prices each candidate through the canonical estimator —
  `cost(m, ceiling(m))` — and, for an **open** dimension, takes `MAX over candidates`
  (§The hold: `MAX`, never `Σ`, because exactly one candidate answers). For pinned siblings it
  is `Σ`, and the shared `T` solve is where the two meet.
- What the rate **is** for: the balance-independent, prompt-independent **total order** on
  candidates (§Smart Model 1). Ranking, greying order and the classifier's option order read
  it; the hold does not.
- The circularity is why the type is shaped this way: the amount depends on the ceiling, the
  ceiling depends on the funding, and the funding is the producer's. With a distinct `kind`, a
  consumer that wants money must supply a ceiling — treating a rate as an amount stops being
  representable instead of being forbidden by a comment (the `model.ts:13-15`
  "don't read it" comment the audit flagged is deleted, not reworded).

### Tests

| Test | Behaviour |
| --- | --- |
| `derive.test.ts` "is a per-token RATE for the model dimension, kinded apart from a money amount" | `reserveContribution(MODEL_DIMENSION, …)` is `{ kind: 'moneyPerToken', nanoUsdPerToken: 3000n }`. Watched red first: `AssertionError: expected { kind: 'money', nanoUsd: 3000n }` — the exact wrong-unit value the audit found pinned. |
| `derive.test.ts` "is the worst option in money for an additive money dimension" | Rewritten. It previously pinned the money arm **using the model dimension**, i.e. the defect was the money arm's fixture. It now uses a synthetic absolute-amount dimension (the shape web search has: `0n` for the off option, `7_000_000n` otherwise) and asserts `{ kind: 'money', nanoUsd: 7_000_000n }` — a stronger pin than before, because worst-of now has ≥2 distinct amounts to choose between. |

Kept as-is and still passing: the rogue-requirement-type tests (a `number` returned by a
nano-USD dimension still throws `TypeError` through the same guard, now reached via the
`moneyPerToken` branch).

## Finding 2 — dead exports

`EffortOptionId` (knip's only new finding in the repo) and `offeredEffortOptionIds` are
**deleted**, not rewired. `offeredEffortOptionIds` had no consumer but its own test and
duplicated `offeredLevels(...).map(level => level.label)`; deleting it leaves `offeredLevels` as
the sole ladder authority, which is what B6 will consume.

`pnpm lint:unused` (knip) after the deletions reports **no new findings** — exactly the two
pre-existing ones Known Breakage names:

```
Unused files (1)
packages/config/vitest.package.config.ts
Configuration hints (1)
wrangler  apps/sandbox  knip.jsonc  Remove from ignoreDependencies
```

## Finding 3 — the pin that cannot fail, replaced

**Deleted:** `re-partition.test.ts` "does not move when the presented set is narrowed to one
option". `partitionPoolTokens(spec, model)` takes no support, so the loop re-issued an identical
call, and the second assertion (`option.optionId.length > 0`) was filler.

**Replacement:** "splits an option's share the same way however many options are presented
beside it". For every fixture model and every offered option it calls
`partitionCeiling(EFFORT_DIMENSION, model, support, input)` twice with the **same chosen
option** and a **different support** — the whole offered set, then that option alone — and
asserts the two `PartitionSplit`s are equal.

- **What it pins:** the split of an already-priced ceiling depends only on the chosen option and
  the ceiling, never on which other options are presented alongside it. That is the claim the
  deleted test was reaching for, on the one derivation whose signature actually varies with the
  presented set.
- **What breaks it:** any implementation that sizes the reservation from the presented set
  rather than the chosen option — the concrete mistake being guarded.
- **Shown to fail.** `partitionCeiling` was temporarily mutated to reserve the worst
  **presented** requirement instead of the chosen option's; the new test went red and the other
  ten in the file stayed green:

  ```
  AssertionError: expected { answerTokens: 0, ceilingTokens: 48000, reservedTokens: 48000 }
                  to deeply equal { answerTokens: 48000, ceilingTokens: 48000, reservedTokens: 0 }
  ❯ src/affordability/dimensions/re-partition.test.ts:90
  Tests  1 failed | 10 passed (11)
  ```

  The mutation was reverted from a byte-copy of the file; `partitionCeiling` is unchanged in the
  shipped tree.
- **Companion control** (in the file's existing control section): "a split sized from the
  presented WORST disagrees when the set is narrowed" asserts that on these fixtures the
  forbidden implementation genuinely produces different reservations for the same chosen option
  under a narrowed set. If the fixtures ever go degenerate that control fails, so the pin above
  cannot quietly stop constraining anything.

The pin list in impl-report-1 §criterion 8 now reads: `maxB(m)` agreement · **split
independence from the presented set** (was the vacuous entry) · the ceiling `Set`-of-one ·
`reserved + answer == ceiling` · `reserveContribution` `none` on every subset · the priced
floor — plus three controls.

## Finding 4 — the wrong-mechanism comment

`premium.ts`'s `exceedsTrialBudget` docblock now reads: the mechanism that drops storage is the
explicit `kind === 'provider'` filter; `inputChars: 0` drops the **input-storage leg alone**;
`output-storage` is a live `kind: 'storage'` line item at the trial tier's real chars-per-token
ratio, so removing the filter silently re-adds a storage charge to a turn that never persists.

Both halves of the old claim verified false before rewriting: `outputCharsPerTokenForTier` is
`CHARS_PER_TOKEN_CONSERVATIVE` only for `paid` and `CHARS_PER_TOKEN_STANDARD` otherwise
(`estimate/pre-adapters.ts:49-51`, so not unit for `trial`), and `price-request.ts:71-87` emits
`input-storage` and `output-storage` as `kind: 'storage'` items with the output leg's rate
scaled by `outputCharsPerToken × modelCount` — nonzero for trial.

## Self-gate

| Command | Result |
| --- | --- |
| `pnpm test:shared` | **pass** — 115 files, 2806 tests, coverage gate green. `affordability/dimensions` 99.43 stmt / 98.05 branch / 100 fn / 100 line (`derive.ts` 99.06/97.01, uncovered 158,273 — the same two defensive lines as before); `effort.ts`, `model.ts`, `registry.ts`, `types.ts`, `premium.ts` all 100 across the board. |
| `npx turbo typecheck --force --continue` (repo-wide) | **pass** — 16/16, zero cached, 0 errors. Kept where the brief requires. |
| `npx eslint src/affordability/dimensions src/affordability/premium.ts` from `packages/shared` | **pass** (exit 0), run **after** the last edit. |
| `pnpm lint:unused` (knip) | exit 1 on the two pre-existing Known-Breakage findings only; the new finding (`EffortOptionId`) is gone. Full output quoted above. |
| `npx vitest run src/affordability/` (targeted, while iterating) | pass — 39 files, 1148 tests. |

`git status --short packages/shared/src/affordability` is a single `??` line (the whole
directory is new in this run), so nothing pre-existing was disturbed.

## Deviations, with reasons

1. **`DIMENSION_RESOURCES` gains a fourth member.** §Cost classes' resource table lists three
   (`money`, `completionTokens`, `none`), and `types.ts` itself calls the set closed. The
   ruling's "a rate-shaped requirement gets its own `kind`" needs a declared discriminator to
   derive that kind from, and the only honest one is the resource — §Data Structures defines
   `requirement` as being "in `resource` units", so a per-token rate IS a different resource
   unit. The alternatives were worse: a new declared boolean on `DimensionSpec` would move a
   derived fact into the declaration, and keying the kind off `spec.id` is per-dimension code.
   **Doc consequence, raised:** the founder's queued doc batch (already holding "§Cost classes
   assigns the model dimension no class at all") now also needs the `moneyPerToken` row. No `.md`
   outside this report was edited.
2. **No `rateToMoney` helper was added.** A helper with no caller would be dead code and knip's
   next finding; the contract above is what B3 reads instead. B3 already owns the estimator call
   that prices `cost(m, ceiling(m))`.
3. **`registry.ts` gained no validation rule for the new resource.** `partition` +
   `moneyPerToken` already derives `{ kind: 'none' }`, and `none`/`free` still pair as before, so
   there is no new internally-inconsistent declaration to refuse. Adding a speculative rule
   would be a guess about a dimension nobody has declared.

## Concerns and limitations

1. **B3 is the first consumer of this union and the contract lives in two places** — the arm's
   docblock in `types.ts` and this report. A wrong consumption is now a type error at the
   `kind === 'money'` narrowing rather than a silent under-hold, which is the property the
   ruling asked for, but no test can pin "B3 did not treat a rate as an amount" until B3 exists.
2. **`registry.test.ts`'s openness test is still named "rejects a non-enumerable dimension at
   registration"**, which now trails the reworded criterion 2 ("rejected when opened"). Left
   alone: it is not one of the four findings, and the assertion itself is correct.
3. **The rate's role as the candidate total order is asserted only in prose.** `MODEL_DIMENSION`
   has no production consumer yet, so nothing pins "the pool is ranked by this number". That pin
   belongs to whichever task builds the candidate pool.

## Confidence

**High.** Each of the four is small, local and evidenced: the unit fix was watched red on the
exact wrong value the audit named, the replaced pin was watched red under a mutant and its
fixtures are guarded by a control, the deletions are confirmed by knip returning to the
pre-existing two findings, and the comment's two false halves were each checked against the code
they describe. Repo-wide typecheck is 16/16 uncached and the shared suite's coverage gate is
green.
