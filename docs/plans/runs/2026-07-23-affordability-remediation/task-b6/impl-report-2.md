# B6 — fix cycle 1

Four findings from the two audits, addressed in one cycle. Plus two corrections to my own
cycle-1 report, both of which were errors in my favour and are recorded as such.

---

## FINDING 1 [Important] — the vacuous pin on the property this task exists to establish

**The defect, confirmed.** `boundOptionOf` matched the returned plan's wire by
**reference**:

```ts
offeredLevels(planned.model).find((level) => level.wire === planned.plan.wire)?.label ??
  REASONING_OFF;
```

`offeredLevels` mints a fresh `ReasoningWire.parse({…})` on every call, and the plan carries
one minted by a *different* call inside `planReasoning`. So `===` is false for every pair,
`find` always returns `undefined`, the lookup always falls through to `REASONING_OFF`
(position 0), and `positionOf(off) > positionOf(anything)` is false for every element. The
violation list was empty by construction. The test passed for any implementation.

The other auditor's structural argument is right and I agree with it: the walk slices
`options.slice(0, indexOf(resolved) + 1).toReversed()` over a declared-ascending support, so
it *cannot* turn upward. **The code is correct; the test was not.** No production change.

**The fix.** Two assertions now, on two different quantities:

1. **Label space, by value.** `sameWire` compares the discriminated wire by content
   (`effort` / `max_tokens` / `enabled`). Where a fully-clamped ladder collapses several
   labels onto one wire, `find` takes the lowest — the weakest true reading, which cannot
   manufacture a violation out of a legitimate plateau.
2. **Budget space, independently.** `budgetCeilingFor` computes the most thinking the
   asked-for option could legitimately buy — the budget of the highest rung at or below it,
   zero when only Min sits below — from the model's own ladder through the shared
   `reasoningBudgetForWire`, never by re-walking the resolver under test. The new test
   *"never spends more thinking than the classified option asked for"* asserts the plan's
   budget never exceeds it. This one has no plateau ambiguity at all.

Both carry vacuity guards (>100 planned arms binding a real rung; >100 with a non-zero
budget), so a lookup that silently degenerated again cannot pass quietly.

### Discrimination, verified — and two mis-targeted attempts recorded

The auditor's bar was "verify it reddens under an upward walk". It took three attempts to
build a mutation that actually *is* one, and the two failures are worth recording because
each looked like a valid falsification and was not:

| Mutation | Result | Why it proved nothing |
| --- | --- | --- |
| `options.slice(indexOf(resolved))` — walk upward from the resolved option | 2 tests red, **not the two under test** | Resolution still ran first, so element 0 is still the correctly-resolved option; it binds the same rung whenever that rung fits. Only the step-down tests moved. |
| distance sort over `options`, keyed on `indexOf(resolved)` | **all 28 green** | Distance from the *already-resolved* option is zero at the resolved option, so the sort is a no-op. |
| **distance sort over the whole ladder keyed on the CLASSIFIED option, ties preferring lower — i.e. the implementation this task deleted** | **11 red, including both repaired pins** | Resolution never happens, so a model offering only High, asked Low, binds High. |

Only the third is the real counterfactual. Both repaired assertions redden under it:
*"never binds a rung above the classified option unless reasoning is mandatory"* and
*"never spends more thinking than the classified option asked for"*. The production file was
restored from a byte copy afterwards and the suite re-verified green (28/28).

That the first two mutations left the pin green is itself the point: a mutation has to reach
the resolution step to test resolution, and the one that does is the deleted code.

---

## FINDING 2 [Minor] — markdown emphasis stripped

**Red first, on shipped code:** `parseDimensionAnswer(EFFORT_DIMENSION, support, 'effort: **Max**')`
returned `undefined` (asserted `'max'`). When it returns nothing the caller applies the
declared fallback, so a classifier that answered Max ran at a different rung — silently, and
with no signal that it had been overruled.

**Fix:** `*` and `_` added to both character classes of `LABEL_NOISE`. No new mechanism, no
second matcher. The comment now states why stripping these is safe rather than merely
convenient: **no option label contains any of these characters**, so the strip cannot swallow
content — which is the property that makes the class extensible without re-arguing it.

The existing formatting-noise case set grew from three cases to eight:
`**Max**` · `*Max*` · `**High**` · `_Mid_` · `__Low__`, alongside the quote/backtick/period
cases already there. The complementary test — *"does not bind a label that merely appears
inside an unrelated answer"* — still passes, so widening the noise class did not re-open the
substring hole it was written against.

---

## FINDING 3 [Minor] — the stray debug script

**It does not exist.** `find . -name "probe-audit*" -not -path "*/node_modules/*"` returns
nothing, and `git status --porcelain packages/shared` lists no untracked file at all.

**I did not create it.** No step of either cycle wrote a file at that path; my only
scratch work went to the session scratchpad outside the repo, and the one temporary probe I
did place inside `packages/shared` this cycle (`emphasis-probe.test.ts`, to observe
Finding 2 before writing the test) was removed in the same command that created it —
verified absent afterwards. Given the mtime the coordinator reports, it was a sibling
auditor's leftover, and it has since been cleaned up by whoever made it. Nothing for me to
delete.

---

## FINDING 4 [Minor] — the client↔server gap, both halves

The producer now prices an empty model list for a turn whose model dimension is closed; the
api priced one model line. Both remained upper bounds on the call, so `reserve ⊇ bill` never
broke — but the client came to price **less** than the server, which is the
affordable-then-402 direction. Closed on the api side, at both sites.

### (a) `models/domain/estimate-run.ts`

`classifierReserveNanoUsd` now takes the prompted list explicitly instead of reading
`node.candidates` itself, and the call site derives it from the **same** authority that
already decides whether the reserve is held at all:

```ts
const promptedModels = dimensions.model ? node.candidates : [];
```

`smartModelClassifierDimensions` is that authority, and it is the same function
`smart-model-execution.ts` short-circuits on — so the list priced and the list prompted
cannot drift apart without one function changing.

**Red first:** a pinned-model auto-effort node priced `39_002_500n`, against `38_865_000n`
for the empty list.

### (b) `models/domain/smart-model-candidates.ts`

`pickEffortClassifier` — whose own doc comment says *"only the effort dimension classifies"* —
priced `[pinned]`, one model line. It now prices `[]`.

**Red first:** the existing expectation `classifierReserve(CHEAP, [BIG])` failed against the
empty-list figure, and the new assertion pins that the two are genuinely different numbers so
the test cannot pass by coincidence.

### Three existing expectations updated, all the same shape

`estimate-run.test.ts` carried three effort-only cases asserting a one-model reserve
(pinned+auto, the fanOut multiplier case, and the classifier-without-context-limit case). All
three now assert the empty list. I also folded the duplicate test I had first written into the
existing pinned+auto case rather than shipping two tests of one scenario.

### A consequence I could not close in bounds — raised

`pinned` is now unused in `pickEffortClassifier`, and lint enforces it
(`unused-imports/no-unused-vars`, "Allowed unused args must match /^_/u"). Removing the
parameter edits its single call site in `chat/domain/smart-model-turn.ts:384`, which is
outside the extension I was granted ("nothing else in either file"). So it is `_pinned`, with
a comment stating plainly that it selects nothing and why it is still there. **The parameter
should be removed by whoever next owns `smart-model-turn.ts`** — it is dead weight that a
future reader will assume is load-bearing.

---

## Two corrections to my cycle-1 report

Both were overstatements in my favour, and both are now on the record as wrong.

1. **Deviation 5 claimed a stale comment was corrected in `estimate/effort-options.test.ts`.**
   That file is byte-identical to HEAD; I corrected no comment there. The claim understated
   my own evidence rather than inflating it — the bounded-exhaustive property block with the
   independent oracle really is **untouched**, which is what makes it usable as evidence that
   the registry delegation is behaviour-identical. A modified oracle would have been worth
   much less. The stale `mandatoryOneLevel` comment I described is still there and still
   stale; it belongs to whoever owns that file next.
2. **I reported `pnpm test:api` as one failed file across four identical runs.** An auditor
   observed two, the extra being a documented stale-optimizer **collection** failure that
   passes in isolation. The verdict is unchanged — no failure attributable to this task — but
   "identical across four runs" was not true, and I should not have leaned on repetition as
   evidence when the second failure class is load-dependent by nature. §Known Breakage warns
   about exactly this and I quoted the warning while making the mistake.

---

## Files changed this cycle

| Path | Why |
| ---- | --- |
| `packages/shared/src/affordability/dimensions/derive.ts` | `LABEL_NOISE` strips markdown emphasis (Finding 2) |
| `packages/shared/src/affordability/dimensions/derive.test.ts` | emphasis cases added to the formatting-noise set |
| `packages/shared/src/affordability/smart-model/effort-dimension.test.ts` | wire equality by value; the independent budget oracle and its assertion; vacuity guards (Finding 1) |
| `apps/api/src/slices/models/domain/estimate-run.ts` | reserve priced against the prompted list, derived from the dimension authority (Finding 4a) |
| `apps/api/src/slices/models/domain/estimate-run.test.ts` | new pinned+auto pin; three effort-only expectations moved to the empty list |
| `apps/api/src/slices/models/domain/smart-model-candidates.ts` | `pickEffortClassifier` prices no model line; `_pinned` marked unused (Finding 4b) |
| `apps/api/src/slices/models/domain/smart-model-candidates.test.ts` | the pinned+auto reserve expectation, plus a not-equal guard |

No production file outside the granted extension was touched.

---

## Self-gate

Run after the last edit anywhere in the repo, statuses captured on the command itself.

| Command | Exit | Result |
| ------- | ---- | ------ |
| `npx turbo typecheck --force --continue` | `TYPECHECK_EXIT=0` | 16/16, 0 cached |
| `eslint .` from `packages/shared/` | `SHARED_LINT_EXIT=0` | clean |
| `eslint .` from `apps/api/` | `API_LINT_EXIT=0` | clean |
| `pnpm test:shared` | `SHARED_TEST_EXIT=0` | 127 files; coverage gate inside it |
| `pnpm test:api` | `API_TEST_EXIT=1` | 1 failed \| 467 passed \| 1 skipped (469 files); 7 failed \| 6421 passed \| 3 skipped (6431 tests) |

The seven api failures are all in `notifications/domain/templates/template-html.test.ts` —
§Known Breakage, the concurrent push/notifications workstream, source and `.snap` both
unmodified relative to HEAD and untouched by this task. **This run showed that one file**;
I am not claiming that as a stable count, because the second class an auditor observed (a
stale-optimizer *collection* failure that passes in isolation) is load-dependent and can
appear or not on any given run. That is the correction in the section above, applied.

Scoped re-verification of the files this cycle touched, run through `scripts/with-env.ts`:
`src/slices/models/domain/` — 20 passed, 1 skipped (488 tests); `packages/shared`
`src/affordability` — 51 files, 1369 tests, all passing.

Lint set derived from `git status`, not remembered: the changed-file list spans
`apps/api`, `packages/shared`, `apps/web`, `packages/config`, `packages/db`, `packages/ui`,
`apps/admin`, `apps/marketing`, `scripts`, `e2e`, `docs` and the repo root. Two of those carry
this cycle's changes — `apps/api` and `packages/shared` — and both were linted whole-package
from their own directories. Everything else belongs to the concurrent workstream.

---

## Confidence

**High** on Findings 1–3. Finding 1 is now falsifiable and demonstrated so against the exact
implementation this task deleted, which is a stronger check than the one I originally
claimed. Finding 2 was measured red and fixed with a widened character class whose safety
argument is a property of the label set rather than a case list. Finding 3 required no change
and is verifiable by anyone re-running the `find`.

**Medium-high** on Finding 4. The arithmetic is straightforward and both halves were measured
red first, but it is a money path, both sites feed live admission, and the shared authority
now spans two packages — so the thing worth an auditor's independent look is that
`smartModelClassifierDimensions` really is the only decider on both sides, rather than my
having matched two call sites by inspection.
