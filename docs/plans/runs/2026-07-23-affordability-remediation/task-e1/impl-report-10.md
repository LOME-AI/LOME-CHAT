# E1 — impl report 10 (effort menu on the producer; the intersection clamp is retired)

## Status

**DONE_WITH_CONCERNS.** The effort menu renders `affordable.turnDimensions` and grades nothing.
The intersection clamp is **gone from `apps/web` entirely** — grep-clean. That was the last surface
where the client could offer or refuse something the producer would not.

One typecheck error remains in the tree and it is **not mine** (see Attribution).

---

## The divergence, measured against the real producer first

Before writing anything I probed `getTurnOptions` with two pinned siblings — A offering
`{low, high}`, B offering `{low, medium, high}` — because I have been wrong about a derived value
before. The producer returned:

```
off    Min   available
low    Low   available
medium Mid   UNAVAILABLE  model_output_cap_too_low
high   High  UNAVAILABLE  model_output_cap_too_low
```

**The clamp was wrong in both directions on this one selection:**

| rung | intersection clamp (`offeredEffortLabels`) | producer |
| --- | --- | --- |
| `medium` | **absent** — only B offers it, so the menu HID it | present, marked with its reason |
| `high` | **enabled** — both siblings name it | **refused** — neither can fund it |

Hiding `medium` was wrong because per-model resolution falls **downward**: A lacking `medium`
resolves to `low`, so the turn can honour it. Enabling `high` was the hazard you named — *a menu
enabling a rung the producer would refuse*. One fixture demonstrates both.

## What landed

- **`reasoning-effort-menu.tsx`** — `effortOptionStates`, `classifyOption` and
  `EFFORT_DISABLED_REASONS` (three locally authored sentences) deleted. `effortOptionsFrom`
  now takes the produced `DimensionAvailability` and only **orders** it: Auto first, rungs
  strongest-first, Min last. Membership and grading are the producer's.
- **Copy** comes from `noticeText(reason)` — the same sentence the send gate gives for that
  condition. The component authors none.
- **`use-reasoning-effort.ts`** — `offeredEffortLabels` and `serverAcceptsChoice` removed;
  `effectiveReasoningSelection` clamps against the **union** (`turnEffortOptions`), not the
  intersection.
- **`usePromptBudget`** exposes `effortDimension` off `affordable` — the greying set, because a
  hold blocks the send and never greys an option.

### Vocabulary sweep

`offeredEffortLabels`, `serverAcceptsChoice`, `EFFORT_DISABLED_REASONS`, `effortOptionStates`
across all of `apps/web`: **zero hits.**

## Inversion

Filtering the presented set to available rungs only — the hide-what-you-cannot-use shape the clamp
had — reddens **six** pins, including the union case and every greyed-never-hidden assertion.
Restored byte-exact (`diff` clean).

## Test disposition, stated because it is a reduction

The 11 tests in `describe('effortOptionStates')` pinned the **local classifier** (`state: 'balance'`,
`'output-limit'`, `'unsupported'`). That classifier no longer exists and the property it asserted is
now pinned inside `packages/shared`. I replaced the block with 4 tests of the new contract —
union membership, ordering, Auto-without-a-dimension, Min omission — rather than porting assertions
about a deleted mechanism. The other 24 tests (chip, slide retention, interaction) survived a
harness change unmodified. Net 35 → 28 in this file; the lost 11 were testing code that is gone.

## Self-gate

| Command | Result |
| --- | --- |
| `vitest run src/hooks/ src/components/chat/ chat.index` (via `with-env`) | pass — **149 files, 2,874 tests**, `TESTS_EXIT=0` |
| `npx tsgo --noEmit` (apps/web) | **one error, in `apps/api` — not mine**; zero web errors |
| `npx eslint` over the changed set (from `apps/web`) | pass — `LINT_EXIT=0` |

Seven lint errors fixed at the cause — `toReversed()` over `reverse()`, narrowing on the union so
an always-falsy branch disappears rather than being suppressed, and an optional parameter instead of
an explicit `undefined` argument. **A third `eslint --fix` was killed at 120s**; I re-ran narrowly
rather than banking the silence, per the standing rule.

## Attribution — the remaining typecheck error is not mine

```
apps/api/src/slices/workflows/nodes/smart-model-execution.ts(239,3): TS2322
  'level' is optional in the source type but required in the target
```

- The file is `apps/api`, which **B9, D1 and C3** hold; I have never edited it (all my changes are
  `apps/web` plus `packages/shared/src/affordability/billing/`).
- `git status` shows it modified by concurrent work.
- The error is about a reasoning-wire `level` field's optionality — C3's territory, and C3 is in a
  fix cycle on exactly this area.
- Zero web-side errors remain.

I am reporting rather than fixing it, per Global Constraint 12.

## Acceptance criteria

| Criterion | Status |
| --- | --- |
| **Existential menu rule; intersection clamp retired** | **MET** |
| Send gate from `admissible`; hold-vs-balance pair | met (report 9) |
| No funding/premium from the balance endpoint | met (report 8) |
| Verdict engine deleted; premium marked not removed | met (reports 6, 7) |
| All greying from `affordable`; typed reasons everywhere | met |
| Session-stable `nowMs`; F1 re-pins; de-selectable row | met |
| Five component tests | **4 of 5** — picker greying, premium/trial marking, heterogeneous multi-model effort, hold-vs-balance. Missing: single-choice model with Auto enabled |
| No text-modality pre-send cost figure | **not verified** |
| `turnDimensions` on a smart-slot-only turn | not done |

## Concerns

1. **The cost-figure criterion is unverified, not met.** I did not get to sweeping the text-arm
   surfaces for a rendered cost figure. `estimatedCostNanoUsd` is documented "decision domain —
   never displayed", but I have not grepped the render paths to confirm, and I am not claiming it.
2. **`turnDimensions` empty on a smart-slot-only turn** is still undecided — the plan asks what the
   turn-level strip renders when no model contributes. The menu now shows Auto alone in that case,
   which is defensible, but nothing pins it.
3. The fifth component test (single-choice model, Auto still enabled) is the deterministic-pick
   case of §Reasoning Effort 10c and is not covered.

## Confidence

**High** on the clamp retirement: the divergence was measured against the real producer before I
built on it, the inversion reddens six pins, and the vocabulary grep is clean. **High** on the
attribution. **Not applicable** to the two unverified criteria above, which I have deliberately not
marked met.
