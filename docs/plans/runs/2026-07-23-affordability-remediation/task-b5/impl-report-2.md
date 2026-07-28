# B5 — implementation report 2 (fix cycle 1)

Both items report 1 declined to ship are now shipped, as ruled. Nothing else from report 1
changed; this report covers only the delta. Report 1 remains the record for the outlier work,
the resolved-corner ruling, the premium collapse and the measurements behind them.

`HEAD` is `53daba72`; the founder's commit absorbed cycle 1's code. Cycle 2's code is in the
working tree on top of it.

---

## (a) The trial-gate storage strip, shipped with its one-line closure

**Two halves of one change**, exactly as ruled — the strip alone widens the hole, the basis alone
leaves storage inflating trial cost.

| file                                                | change                                                                                                                                    |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `models/domain/trial-eligibility.ts`                | `trialMessageBillableNanoUsd(target, promptChars)` — provider items only, and a character COUNT rather than prompt text plus history.        |
| `chat/routes.ts`                                    | the granted line: the trial gate is passed `budget.promptCharacterCount`, the value computed fourteen lines above it. Nothing else touched. |
| `models/domain/trial-smart-model-candidates.ts`     | its call to the same gate, given the same basis — see "the one file I had to touch".                                                        |

### What the gate now guarantees

Both the gate and the compiled turn's floor price the identical input; the gate allocates 2,000
output tokens where the floor allocates 1,000. So

```
gate − floor = 1,000 × outputRate(m)      exactly, for every rate shape
```

That is an identity, not a band. It is pinned per shape — including `input dearer` (400/100) and
`input far dearer` (4,000/100) — by amount, and a companion pin measures what the gate WOULD admit
if the basis narrowed back to history-plus-prompt: for the 4,000/100 shape it lands
`unpricedInputTokens × 4,000 − 1,000 × 100` BELOW the floor. The pair is what stops the two halves
being separated later.

The old boundaries from report 1 (fails past ≈32.5× inverted as shipped, past ≈1.25× after a
bare strip) are gone: there is no boundary now.

### Eligibility, re-measured for what actually shipped

Over the same live pool (182 exposed rows, 176 text, 81 trial-eligible models), counting how many
pass the 1¢ per-message gate. "Before" is the shipped-in-cycle-1 gate (storage in, user text only);
"after" is what this cycle ships (no storage, whole send including the system prompt):

| user characters | before | after  | change  |
| --------------- | ------ | ------ | ------- |
| 0               | 81     | 81     | —       |
| 200             | 81     | 81     | —       |
| 2,000           | 77     | 81     | **+4**  |
| 20,000          | 11     | 61     | **+50** |

The widened basis costs one model at 20,000 characters relative to a storage-strip-only change
(61 rather than 62) — the ~870 system-prompt input tokens are now honestly priced. The headline
for the founder is unchanged in shape and only slightly smaller in size: **on a long trial
conversation the usable model count goes from 11 to 61.**

### And a second trial cost that was never real

Deleting the classifier-storage emitter (below) also removes a storage charge from the TRIAL
Smart Model reserve, which is gated against the same 1¢ ceiling. Measured through
`classifierReserveChars` at the real prompt overhead:

| candidate list | classifier storage removed (trial ratio) |
| -------------- | ---------------------------------------- |
| 1 candidate    | 3,900,900n (**0.39¢**)                   |
| 5 candidates   | 3,980,100n (0.40¢)                       |
| 20 candidates  | 4,280,100n (0.43¢)                       |
| 81 candidates  | 5,506,200n (**0.55¢**)                   |

A trial Smart Model send over the full eligible pool was spending **over half of its entire 1¢
ceiling** reserving storage for a classifier call that stores nothing. On the paid path the same
term is 0.27–0.43¢ per turn of over-reservation. Both were in the safe direction, and both are
gone.

---

## (b) The classifier-storage emitter, deleted

`estimate/classifier-line-item.ts` returns one item, `classifier-tokens`. Deleted with it: the
storage computation, the `outputCharsPerToken` parameter, and `ClassifierStage.inputChars` (its
only reader was that computation). No storage number is subtracted anywhere.

All four folds became no-ops simultaneously, exactly as ruled. What I additionally cleaned, and
why each is inside the ruling rather than beyond it:

| site                                                     | disposition                                                                                                                                                                       |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `estimate/classifier-line-item.ts`                       | **emitter deleted.**                                                                                                                                                              |
| `estimate/smart-model-affordability.ts`                  | `classifierStorageNanoUsd` **deleted** — not "left as a dead read": it is in my own file, it always returned `0n`, and its `v8 ignore` comment asserted the emitter still emits.   |
| `models/domain/estimate-run.ts` (mine)                   | the `storageContext === undefined ? filter : items` branch collapses to an unconditional `kind === 'provider'` selection, and the function loses its now-unused storage argument.  |
| `models/domain/trial-smart-model-candidates.ts` (not mine) | its generic `for … reserve += item.fixedNano` needed no logic change; I fixed the two comments that claimed it folds storage, and dropped the argument (see below).                 |
| `turn-core.ts`                                           | already selected provider positively; it loses its now-meaningless `tier` argument.                                                                                               |

The positive `kind === 'provider'` selections stay at the fold sites even though only one kind is
emitted — they are what keeps a future item out of a hold silently.

### The one file I had to touch outside the list, and why twice

`models/domain/trial-smart-model-candidates.ts` is not in the Files list, and both ruled changes
land on it:

- **(a)** it calls `trialMessageBillableNanoUsd`. The ruled signature change breaks the call, and
  the value it needs is not in its input. Threading `promptCharacterCount` down to it would have
  changed `TrialSmartModelCandidatesInput` AND `chat/domain/smart-model-turn.ts` (whose `budget`
  is optional, so it needs a decision, not an edit) — a cascade well past what was granted.
  Instead it computes the same count locally through the SAME shared counter the route uses
  (`promptCharacterCount` over `buildTurnSystemPrompt`), using the `nowMs` it already receives.
  Four lines, no interface change, no cascade.
- **(b)** it passed the third argument to `classifierReserveLineItems`. Keeping a vestigial
  `_outputCharsPerToken` parameter alive purely for this caller was the alternative; since (a)
  already required an edit here, deleting the parameter properly was strictly cleaner.

**A residual, stated plainly:** the trial Smart Model path prices the system prompt but not custom
instructions, because they do not reach it. The single-model trial gate prices both. The escape
that leaves is a trial + Smart Model + custom-instructions + inverted-rate turn; 0 of 176 live text
models are inverted (measured in report 1). Closing it means giving that path the route's own
number, which is the cascade above.

---

## Self-gate

| command                                                | result                                                                             |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `pnpm test:shared`                                     | pass — 127 files, 3,017 tests; coverage 99.9 / 99.46 / 100 / 100                    |
| `npx vitest run --root packages/shared src/affordability` | pass — 51 files, 1,345 tests                                                       |
| `pnpm test:api`                                        | see "the api gate" below                                                           |
| `pnpm test:web`                                        | pass — 395 files, 6,432 tests                                                      |
| scoped: `--root apps/api src/slices/{models,chat,workflows}` | **pass — 98 files, 2,003 tests, 1 skipped**, on the final source                    |
| `npx turbo typecheck --force --continue`               | pass — 16/16, zero cached                                                          |
| `eslint src/affordability` (packages/shared)           | exit 0 after the last edit                                                         |
| `eslint <changed files>` (apps/api)                    | exit 0 after the last edit                                                         |
| coverage, `src/slices/models/domain/*`                 | `trial-eligibility.ts` and `trial-smart-model-candidates.ts` at 100 on every axis   |

### The api gate

`pnpm test:api` ran five times across this cycle. Two finished; **three crashed after the tests,
inside the coverage merge**, on `ENOENT … apps/api/coverage/.tmp/coverage-N.json` with **zero
`FAIL` lines** — the known upstream Vitest bug (recorded previously: no fix exists, the heap flag
does not address it). A crash there says nothing about the tests, and it hides the coverage gate
the same way a red run does. I tested and DISPROVED one hypothesis worth recording so the next
agent does not repeat it: deleting `apps/api/coverage` between runs is NOT the trigger — the fifth
run left the directory alone and crashed anyway. It correlates with machine load.

The one complete run on essentially-final source showed **11 red of 6,431**, every one attributed
below. The three slices this cycle touches were then re-run whole on the final source: **98 files,
2,003 tests, 1 skipped, zero failures.**

Attributed elsewhere, all reproduced on files this task never touched and all passing when re-run
in isolation (3 files, 246 tests green):

- `notifications/.../template-html.test.ts` — 7 snapshot failures, the listed concurrent-workstream
  entry.
- `chat/routes.integration.test.ts` ×2 and `models/domain/refresh.integration.test.ts` —
  `model-catalog test lock: timed out acquiring` / its hook timeout, the listed load-dependent
  entry naming `refresh.integration.test.ts` by name.
- `identity/routes-edge.integration.test.ts` — a rate-limiter edge (`expected 200 to be 429`) on
  the shared Redis; nothing in this task touches identity.

---

## Corrections to report 1

- **The system prompt grew under me, in the founder's commit.** Report 1 recorded 1,609 characters
  and speculated about "a different loaded copy of `@hushbox/shared`". It measures **1,739**
  characters now, and `packages/shared/src/prompt/` was clean against the OLD `HEAD` when I
  checked — `53daba72` carried the change. Nothing in this task depends on the figure any more:
  every assertion derives it at run time.
- Report 1's before/after eligibility table described a storage-strip-only change. The table above
  supersedes it for what shipped.

## Concerns

- **Two trial gates now price two different bases**, and only for the reason above: the route's
  gate includes custom instructions, the Smart Model path's does not. One implementation, two
  inputs — not two implementations — but the asymmetry is real and should die when lane C or B8
  gives the Smart Model path the route's number.
- **`estimate-run.ts`'s classifier reserve no longer varies with the tier**, so its
  `storageContext` argument disappeared from that one function. The node's OTHER storage terms
  (candidate output, prompt input) still use it; only the classifier leg lost it.
- The paid hold falls by 0.27–0.43¢ per Smart Model turn and the trial reserve by 0.39–0.55¢.
  Holds moving DOWN is the safe direction, and caps and hold moved together in one change.
  **One hold-side pin did encode the old figure and I changed it**:
  `estimate-run.test.ts`'s persisting-turn storage delta asserted `classifierStorage +
candidateOutputStorage + inputStorage`. It now asserts the latter two, and additionally measures
  what the classifier storage WOULD have been and asserts that figure is non-zero — so the
  assertion cannot pass by the term having quietly become small rather than absent. No other pin
  in `packages/shared` or `apps/api` moved, which is evidence the term lived only in the reserve
  path.

## Confidence

**High.** Both changes are pinned by amount, the gate's dominance is now an identity rather than a
measured band, and the eligibility effect is measured over the live catalog rather than argued. The
one thing I would not call finished is the custom-instructions asymmetry on the trial Smart Model
path, which is named above and needs an owner.
