# B8 — impl report 4 — Finding 6

One finding: a test comment that generalised a two-case observation to seven. Comment-only code change;
the two report corrections and the stale raise are recorded below.

## Files changed

| file | what changed |
| --- | --- |
| `packages/shared/src/affordability/turn-options.premium.test.ts` | the guard block's comment: the universal quantifier removed, both failure directions named, the measurement located in this report rather than summarised in prose |

No production file changed this cycle. The guard itself, its message and its call site are untouched;
`turn-options.ts:58-60`'s docblock was already correctly scoped ("a **non-comparable** instant makes
every recency test false") and stays as it is.

## The corrected comment

```ts
// A clock a caller got wrong changes premium classification, which is a money
// verdict — so an unusable instant is refused where the snapshot enters the
// module, the same posture this module already takes on `promptChars` and on an
// empty identifier.
//
// The guard refuses BOTH directions of unusable, and the direction is not
// uniform across these cases: a non-comparable instant (`NaN`, `+Infinity`)
// makes every recency test false and fails permissive — a premium row comes back
// available; a sub-window instant (`-Infinity`, `0`, `-1`, just under the
// window) makes every model read as recently released and fails closed. A
// fractional instant changes no verdict at all and is refused for being
// unusable rather than for what it decides. Measured case by case with the guard
// bypassed, and recorded in this task's report rather than summarised here.
```

Three properties of the new wording, deliberately: it quantifies nothing over the case list, it names
the mechanism for each direction (recency test false vs. window reaching before the epoch) rather than
the observed verdict, and it points at the measurement instead of restating a number a later edit could
falsify.

## The per-case direction table — measured, not reasoned

Method: `requireUsableInstant` bypassed behind a probe flag, then that file's own fixture evaluated once
per case — single-model pool, `releasedAtMs = NOW_MS - DAY_MS`, free tier, so the row is premium by the
recency leg alone. The guard was restored from a pre-edit copy immediately afterwards and
`turn-options.ts` re-verified to contain exactly `requireUsableInstant(catalog.nowMs);` with no probe
branch.

| instant | verdict with the guard bypassed | direction |
| --- | --- | --- |
| `NOW_MS` (control) | `{available: false, reason: 'premium_requires_credit'}` | — correct |
| `Number.NaN` | `{available: true}` | **permissive** |
| `+Infinity` | `{available: true}` | **permissive** |
| `-Infinity` | `{available: false, reason: 'premium_requires_credit'}` | **closed** |
| `NOW_MS + 0.5` | `{available: false, reason: 'premium_requires_credit'}` | **no change** — identical to the control |
| `0` | `{available: false, reason: 'premium_requires_credit'}` | **closed** |
| `-1` | `{available: false, reason: 'premium_requires_credit'}` | **closed** |
| `PREMIUM_RECENCY_MS - 1` | `{available: false, reason: 'premium_requires_credit'}` | **closed** |

2 permissive · 4 closed · 1 no-change. Reproduces the audit's count exactly, independently measured.

Why each direction falls where it does, since the table alone does not explain it: the recency leg is
`releasedAtMs > nowMs - PREMIUM_RECENCY_MS`. A non-comparable instant makes that comparison false for
every model, so nothing classifies premium by recency and the row opens. A sub-window instant makes the
right-hand side negative — earlier than any release date — so every model classifies premium and the row
shuts. A fractional instant is an ordinary comparable number half a millisecond from the correct one, so
it decides identically; it is refused because it cannot be an instant, not because of what it decides.
That is the asymmetry the audit named better than my earlier wording did: `NaN` and `±Infinity` are
**unusable values, recognisable from the value alone**; a plausible-but-wrong future instant is a
**wrong value only its server can recognise**, which is why the guard has a floor and no ceiling.

## The two corrections carried in

1. **The no-behaviour-change truth-maker — third pass, and the previous two were both mine to get
   right.** My cited artifacts were real and the sweeps do exercise the new gate, but they do not
   *discriminate* this change's collapse shape, and I did not check that: `greyedCount > 0` moves the
   permissive way under a collapse (more greying satisfies it), `rowsWithRungs` counts candidate rows
   irrespective of availability, and `sendable > 20` / `setsDiffer > 5` are satisfiable by the ~1/4 of
   draws at `paid` alone. The sentence I am adopting, matching the ledger:

   > The sweeps exercise the gate at every tier over a pool where rows do classify premium, assert
   > per-entry presence, prefix and subset on every draw, and are green; the gate's own verdicts are
   > pinned separately in `turn-options.premium.test.ts`.

   The transferable lesson, and the one that would have caught all three passes: **the existence of a
   cited artifact is not discrimination by it.** For a claim of the form "this test would have caught
   X", the check is not "does the assertion exist and pass" but "does X move the assertion the failing
   way" — which is the same question as the vacuity findings this run has hit repeatedly, asked about a
   test instead of a comment.

2. **Two tallies were wrong in report 3.** `turn-options.premium.test.ts` runs **14** tests, not 18 — 18
   was the combined premium + `model-id` run I quoted from. This cycle's predecessor added **10** to
   that file, not 9: 7 rejection cases + 1 deliberate boundary acceptance + 2 clock-immunity pins, on
   top of the 4 original premium pins, which is exactly the 14 the file now reports. Substance
   unchanged; the arithmetic now closes.

## The stale raise, withdrawn

My standing raise that "the 22 unowned `apps/api/src/slices/models/**` inventory rows block B8b" is
**withdrawn**: §B9 now owns them and B8b is gated on B9. I was reading a §B8/§B8b pair that predated it.
The inventory rows themselves are unchanged and still need re-deriving at B8b time, since C2 moved two
of them while B8 ran.

## Self-gate (after the last edit)

| command | result |
| --- | --- |
| `npx vitest run src/affordability/turn-options.premium.test.ts` | pass — **14 tests** |
| `pnpm test:shared` (coverage gate on) | **pass** — 132 files, 3181 tests, no per-file threshold error |
| `eslint .` in `packages/shared`, from the package dir, after the last edit | **exit 0** |

No repo typecheck this cycle: the only change is a comment inside a test file, and the preceding cycle's
`turbo typecheck --force --continue` (16/16, uncached) covers every declaration untouched since. Stated
rather than silently skipped.

## Acceptance criteria

No criterion's verdict changes. Finding 6 was an evidence-overstatement inside a test comment, in the
class this codebase treats as worse than no comment; the guard, its scope and its pins are as report 3
described them.

## Concerns and limitations

1. **The recency-only residual stands** and is now better named by the audit's framing: a
   plausible-but-wrong future instant is recognisable only by the server that supplies it, so closing it
   is a served-value contract for B9/E1/C3, not a check the money layer can perform.
2. **The guard's floor remains coupled to `PREMIUM_RECENCY_MS`** (report 3, concern 2) — unchanged, with
   the boundary case pinned accepted.
3. **Report 2's open items are unchanged and belong to other tasks**: the classifier prompt still renders
   the declared effort domain (C3, needs a C2 file); C1's `CLASSIFIER_EFFORT_FALLBACK = 'medium'`
   contradicts §Reasoning Effort 8's cheapest-presented rule; `OptionSet` cannot express whether the
   model axis was open; and the five `BILLING.md` corrections are the founder's to rule on.

## Confidence

**High.** The change is one comment, the table behind it was measured rather than argued, the guard was
restored from a pre-edit copy and re-verified by grep, and the file's own tests plus the package's
coverage gate are green.
