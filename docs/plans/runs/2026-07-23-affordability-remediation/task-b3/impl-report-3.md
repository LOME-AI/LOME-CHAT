# B3 — `getTurnOptions`: one producer, two sets — implementation report 3

## Objective

Two validated findings against report 2. **Finding 1 (critical):** the set the classifier is
presented and the set the hold's `MAX` is taken over were different sets — a candidate was
graded on itself alone while `viableCandidates` required every sibling of its arrangement to
fit, so a candidate whose arrangement starves a pinned sibling was presented as runnable yet
excluded from the hold. **Finding 2 (minor):** the web-search amount was expressed twice inside
one function. Nothing else was in question; report 2's six discharged findings were not
revisited.

## Files changed

| File                            | Why                                                                                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `turn-core.ts`                  | Finding 1: a candidate is graded on its whole arrangement (`arrangementBlock`), so the presented set and the held set are one set. Finding 2: the solve reads the web-search line item's own amount. |
| `turn-core.test.ts`             | The exact repro, and the owed property as a two-regime funding sweep measured through the producer.                                     |
| `turn-options.property.test.ts` | The turn-level option union added to `expectSubset` — the premise the coordination note names, now asserted rather than argued.         |

No file outside `packages/shared/src/affordability/turn-*` was touched, and **no exported
signature changed**: `arrangementBlock`/`blockingReason` are module-private, `CoreResult`,
`OptionSet` and every type in `turn-types.ts` are untouched. A repo-wide grep for `turn-core`,
`turn-arithmetic`, `turn-options` and `turn-types` across `apps/`, `packages/`, `scripts/` and
`e2e/` still finds nothing outside `packages/shared/src/affordability/`, so there is no
consumer to sweep (Global Constraint 10 re-checked this cycle, not carried over).

## Finding 1 — the two sets are now one set

**The defect, in the code.** `entryFor` graded every row through `siblingBlock(model,
arrangement, …)` — the model's own fit inside its arrangement. `holdArrangement` takes the `MAX`
over `viableCandidates`, and `Arrangement.viable` is the conjunction over **all** siblings. A
candidate that fits while a pinned sibling starves therefore satisfied the first and failed the
second: presented to the classifier, absent from the hold.

**The fix.** A candidate entry's verdict is now the arrangement's:

```
arrangementBlock(a) = undefined              if a.viable
                    = blockingReason(a)      otherwise   (refusalPrecedence over its siblings)
```

`arrangement.viable` and `arrangementBlock` are two readings of one predicate, so
`runnable ∩ candidates` **is** `viableCandidates` by construction rather than by agreement. That
is §Turn Stories 1.2 in its own words — a candidate survives iff "money for all three siblings
plus the classifier reserve, and `B + MINIMUM_OUTPUT_TOKENS` inside **every** sibling's ceiling"
— and it restores §Turn Stories 1.3's hard gate.

`candidateBlocks` (the borrowed reason when a smart slot has nothing viable) reads the same
predicate, so "why this candidate is out" has one definition.

**Scoped to candidate rows, deliberately.** A pinned row is still graded on its own fit inside
the pinned arrangement, so a payer sees *which* sibling is the problem rather than every pinned
row greyed with a borrowed reason. This changes no verdict: `turnRefusal` already collects every
selected entry's reason, and a borrowed reason can only duplicate a code already in that
multiset, so `refusalPrecedence` returns the same refusal either way. A pinned row is also not
an arrangement the classifier can pick, so it carries no `reserve ⊇ bill` obligation.

### The exact repro, passing

Catalog (short ids deliberately — the classifier reserve prices the prompt overhead from model
ids, so id length is load-bearing on every amount below): `v/pin` 60n/150n, ctx 200,000, cap
64,000, reasoning `high|medium|low` · `v/cheap` 5n/10n, ctx 128,000, cap 65,000 · `v/dear`
20,000n/90,000n, ctx 64,000, cap 32,000. Basis 2,000 + 0 + 2,000 + 1,000 = **5,000 chars**,
tier `paid`, funding **120,000,000n**, `pinned: { effort: 'high' }`, one pinned sibling `v/pin`
beside a smart slot.

|                        | before                                              | after                                     |
| ---------------------- | --------------------------------------------------- | ----------------------------------------- |
| `runnable`             | `v/pin@64000`, `v/cheap@65000`, **`v/dear@1022`**    | `v/pin@64000`, `v/cheap@65000`             |
| `v/dear` entry         | `{ available: true }`                               | `{ available: false, reason: 'insufficient_funds' }` |
| `holdNanoUsd`          | `89_263_685n`                                        | `89_263_685n` — **unchanged**              |
| `v/dear`'s arrangement | priced `119_967_135n` — **30,703,450n / +34.4% over the hold** | not presented                   |

The 119,967,135n is the arrangement `[v/pin, v/dear]` priced through the exported vocabulary at
the same context: `T = 1022`, `v/pin` costs 2,341,500n at ceiling 1,022 (its `high` budget does
not fit, which is why the arrangement is not viable) and `v/dear` 117,593,200n, plus the
32,435n classifier reserve. The brief's ≥119,934,700n is the same number with that reserve
excluded, exactly as it said, so the two measurements agree to the reserve.

Pinned as `withholds a candidate whose arrangement starves a pinned sibling`. Red first:
`expected [ 'v/cheap', 'v/dear' ] to deeply equal [ 'v/cheap' ]`.

### The owed property, and its pre-fix red

> **The hold is ≥ the priced total of every arrangement a presented candidate can create.**

Pinned as `holds at least the priced total of every arrangement a presented candidate can
create`, over both effort regimes (`high` and open) × 381 funding steps from 20,000,000n to
400,000,000n on the repro catalog: 200+ presented candidates checked, 100+ sendable draws, 50+
withheld candidates required as controls.

**The arrangement total is measured through the producer, never re-derived** — a second pricing
implementation is the artifact CODE-RULES bans. For candidate `c` the same turn is re-priced
with `c` **pinned in place of the slot**, so the arrangement's membership and order are
identical. The one difference between the two pricings is the classifier reserve, so the
resolved turn's funding is corrected by both reserves — each **read off produced line items** —
which equalises `funding − fixedCosts` and therefore the shared token count; the resolved total
minus its own reserve is the arrangement's sibling cost. A reserve is a function of the catalog
and the tier alone and never of the funding, so reading it off a first pricing pass cannot bias
the second. On the repro this reproduces the hold to the nano: `89_231_250n + 32_435n =
89_263_685n`.

**Red against the current (pre-fix) code**, for the sharpest possible reason:

```
× holds at least the priced total of every arrangement a presented candidate can create
  AssertionError: expected undefined to be defined
  at expect(total).toBeDefined()
```

`undefined` there means the resolved arrangement is **not sendable at all** — a presented
candidate whose arrangement no hold covers, because the funding cannot buy it. Post-fix both
assertions pass.

### What moved, and what did not

A differential over **83,520 turns** (4 tiers × 6 effort pins × 0–2 pinned siblings × slot
on/off × 12 basis lengths × 58 fundings, on a 6-model catalog including the dear outlier), run
twice from the same script with only the grading call sites inverted:

| quantity                                | rows changed                        |
| --------------------------------------- | ----------------------------------- |
| `holdNanoUsd`                           | **0**                               |
| `admissible.sendable`                   | **0**                               |
| `affordable.sendable`                   | **0**                               |
| `admissible` presented set — shrank     | 20,631 (never gained: 0)            |
| `affordable` presented set — shrank     | 23,277 (never gained: 0)            |

So the hold is byte-identical, which is what the coordination note predicted and the reason is
structural: the `MAX` domain was already `viableCandidates`, and the fix removes from the
presented set exactly the candidates that were never in that domain. Nothing entered the `MAX`
domain that was not already there. The only movement is the presented set narrowing, in one
direction only.

**The STOP-AND-ASK condition is not triggered**, on two independent grounds. Structurally,
sendability with a smart slot was already gated on `viableCandidates.length > 0` and on every
selected entry being available — the fix changes neither, it only reads the same predicate into
the candidate rows. Empirically, sendability changed on **0 of 83,520** turns on both arms. And
§Turn Stories 1.2 requires the narrower set in the first place, so the narrowing is what the
spec says rather than a product change made on my judgment.

### The two monotonicity premises, re-checked

**Premise A — "∃ viable candidate" is monotone only because each candidate arrangement has fixed
membership.** Still holds and is untouched: membership is still `pinned + candidate`, fixed by
the selection; `viableCandidates` and `turnRefusal` are unchanged. What the fix adds is that a
candidate *row's* availability is now that same conjunction — an AND of monotone predicates over
a fixed membership, hence monotone, so the row cannot gain availability from a poorer pass.
Asserted by the 400-draw subset sweep (which counts 20+ smart-slot-beside-pinned draws and 5+
draws where the candidate sets flip between passes) and the 601-step funding sweep.

**Premise B — `contributorsOf` feeds `turnDimensionsFor` from `runnable`, safe only because
`mergeTurnOption` prefers an available option, so extra contributors can only add
availability.** This is the premise the fix touches, because `runnable` shrinks. It survives:
the contributor list is the pinned rows plus the runnable candidates, candidate runnability is
monotone, so the affordable pass's contributor list is a superset of the admissible pass's, and
a union that prefers availability over a superset can only be more available. **I stopped
arguing it and pinned it:** `expectSubset` now also asserts the **turn-level** union
(`admissible.turnDimensions` availability ⊆ `affordable.turnDimensions`, per rung), which no
previous sweep covered — the earlier assertions were all per-model rows.

Positive control, because a new assertion that passes first time proves nothing: inverting
`mergeTurnOption` to prefer the **unavailable** option — the exact premise — turns 3 of the 6
property tests red, all three at that new line (`turn-options.property.test.ts:179`), including
the 400-draw sweep. The file was restored byte-identically afterwards (`diff` clean against a
pre-control copy).

**The finding-1 sweeps are still clean:** the whole affordability directory is 47 files / 1,299
tests green, including the 400-draw subset sweep, the 200-draw basis-only sweep, the 601-step
funding sweep, the three pinned-arrangement regression pins from report 2, the completeness
biconditional and the re-partition invariant.

## Finding 2 — one home for the web-search amount

`priceArrangement` no longer multiplies `WEB_SEARCH_RESERVATION_NANO_PER_MODEL` by the sibling
count. It builds the line item once and the solve reads the item's own `fixedNano`:

```ts
const searchItem = context.webSearch ? webSearchLineItem(siblings.length) : undefined;
const additiveNanoUsd = searchItem?.fixedNano ?? 0n;
```

The item is then pushed rather than rebuilt, and the now-unused
`WEB_SEARCH_RESERVATION_NANO_PER_MODEL` import is gone. Behaviour-identical by construction
(the builder computes the same product), so this is guarded by the existing amount pins rather
than a new test: the 172,500,000n three-model line item and the hold's rise by exactly that when
the toggle flips both still pass unmodified. `webSearchLineItem` throws below one model, which
is unreachable here — every arrangement has at least one sibling (a candidate arrangement
contains its candidate; a pinned arrangement is only built when something is pinned).

## Tests added

| Test                                                                                    | Behaviour                                                                       | Criterion |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | --------- |
| `withholds a candidate whose arrangement starves a pinned sibling`                       | the exact repro: `v/dear` marked, hold and both other ceilings unchanged         | finding 1 |
| `holds at least the priced total of every arrangement a presented candidate can create`  | the owed property, both effort regimes, arrangement priced through the producer   | finding 1 |
| `expectSubset` extension (turn-level union)                                              | `admissible ⊆ affordable` at the turn-option level, on every existing sweep       | premise B |

## Self-gate

| Command                                                                     | Result                                                        |
| --------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `npx turbo test --filter=@hushbox/shared --force`                            | **pass** — 123 files, 2,957 tests, coverage gate green         |
| `npx turbo typecheck --force --continue`                                     | **pass** — 16/16, zero cached                                  |
| `pnpm arch:check`                                                           | **pass** — 11 rules over 2,016 files                           |
| `eslint src/affordability/turn-core.ts turn-core.test.ts turn-options.property.test.ts` from `packages/shared`, after the last edit | **pass** — exit 0 |
| `pnpm test:api`                                                             | 1 file / 7 tests fail (465 files, 6,391 tests pass) — pre-existing, attributed below |

Coverage of the changed files: `turn-core.ts`, `turn-arithmetic.ts`, `turn-options.ts` and
`turn-types.ts` each **100 / 100 / 100** (lines / branches / functions).

**One dead branch removed rather than ignored.** The fix made `candidateBlocks`'
`block === undefined` arm unreachable — it is only called when nothing is viable, so every
arrangement there has a reason — which showed up as `turn-core.ts` branches 98.87%. Instead of a
`v8 ignore`, `arrangementBlock` was split: `blockingReason(arrangement, context)` is total and
returns the reason, `arrangementBlock` is the `viable ? undefined : blockingReason` wrapper, and
`candidateBlocks` calls the total one. Branch coverage is back to 100 with no new ignore
comment.

### `pnpm test:api`, attributed

`src/slices/notifications/domain/templates/template-html.test.ts` — 7 snapshot failures out of
467 files (465 passed, 1 skipped; 6,391 tests passed). Not mine, on the same three grounds as
the previous two cycles: it is §Known Breakage's named `apps/api` entry ("the single `apps/api`
failure a scoped run will show"), and the numbers are identical to both earlier cycles;
`git diff --stat HEAD -- apps/api/src/slices/notifications/domain/templates/` is empty at
HEAD = `39a07db0`, so neither template nor snapshot has moved; and this task touched no file
under `apps/api`, which imports none of the modules I changed (grep above). I checked the
second-cause hazard: the failing file, test count and assertions match the entry as written, my
change cannot reach a template, and repo-wide typecheck is green over all 16 packages. The five
`model-catalog test lock` timeouts did not appear in this run.

`pnpm test:web` and the marketing suite were not re-run: no file outside
`packages/shared/src/affordability/turn-*` changed, nothing imports those modules, and
repo-wide typecheck is green.

## Acceptance criteria

Report 1's and report 2's evidence stands except where these findings moved it. Deltas only:

- **"The hold must cover every arrangement a PRESENTED candidate can create"** (the criterion
  this cycle's finding added to the plan) — **met**, by the property above with pre-fix red
  evidence, plus the exact repro with the measured overrun, plus the 83,520-turn differential
  showing the hold itself did not move.
- **Completeness `presented == feasible` over the `admissible` set** — **met and now stricter.**
  "Feasible" for a candidate is arrangement-level, which is what §Turn Stories 1.2 defines it
  as; the completeness fixture and its biconditional both still pass unchanged.
- **`admissible ⊆ affordable` per model and per option** — **met, strengthened** to the
  turn-level union, with a watched control.
- **Web search reserves 10 × $0.005 × model count, pinned by amount** — **met, unchanged
  amount**, now with one home for the figure inside the producer.
- **Options are marked, never filtered** — **met.** The narrowing removes nothing from `all`: a
  withheld candidate is present with `{ available: false, reason }` and every rung greyed with
  that reason. The 150-draw sweep asserts one entry per catalog model on both arms.

## Deviations, with reasons

Report 1's and report 2's deviations stand. New this cycle:

1. **The grading change is scoped to candidate rows; pinned rows keep their own-fit verdict.**
   The brief's preferred direction ("exclude a candidate from `runnable` when its own arrangement
   is not viable") is exactly this. Extending it to pinned rows would grey every pinned row
   whenever one of them starves, losing the "which sibling is the problem" diagnosis for no
   money gain — the refusal code is provably unchanged either way, and a pinned row is not an
   arrangement the classifier can pick. Recorded because it is the one place the fix is narrower
   than "make every entry arrangement-graded".
2. **`entryFor` takes its `block` from the caller.** That is what lets the two grading rules live
   at the two call sites where the difference is documented, rather than a mode flag inside the
   entry builder.

## Concerns and limitations

Report 2's concerns stand, except that its concern 2 (a pinned sibling's presented ceiling is
optimistic when a slot is unresolved) is now the **only** remaining presentation-side optimism —
the candidate side is closed. Report 2's concerns 1 (three tier-axis refusal codes have no
producer), 3 (`turnDimensions` empty on an unsendable slot-only turn), 4 (`reasoning-plan.ts`
carries plan identifiers — pre-existing, outside ownership) and 5 (a mandatory-single-rung model
reserves `B = 0`) are unchanged, as are report 1's concerns 1–4, 7 and 8.

New this cycle:

1. **A third defect of the same family, found while re-checking premise B, NOT fixed:
   `mergeTurnOption` ORs the turn-level effort union over PINNED siblings, where §Turn Stories
   2.1 requires an AND.** §Story 2.8's "an effort is enabled iff at least one contributor can
   honour it" is a rule about **candidates**; §Story 2.1 says the opposite for pinned siblings —
   "any effort where a pinned sibling cannot fit `B + MINIMUM_OUTPUT_TOKENS` inside its ceiling
   is gone turn-wide … the pinned models are not chooseable, so they cap the whole turn."
   Measured: two pinned siblings, no smart slot, effort open, `vendor/a-cheap` (cap 64,000,
   reasoning) beside a 9,000-cap reasoning model — the turn menu marks `high`
   `{ available: true }` at every balance from 200,000,000n to 6,000,000,000n while the same
   selection with `pinned: { effort: 'high' }` is **unsendable** (`model_output_cap_too_low`).
   That is a menu enabling a level the send gate refuses, which §Reasoning Effort 3 forbids
   outright. It is **pre-existing and not a regression of this fix** — the repro has no smart
   slot, so `contributorsOf` returns the pinned rows alone and the fix cannot reach it. I did
   not fix it: it is outside the two validated findings, it changes what the picker shows, and
   the coordination note names `mergeTurnOption`'s prefer-available behaviour as a premise I was
   told not to break. The correct rule is AND over pinned siblings, OR over runnable candidates.
2. **The owed property's measurement technique is worth keeping in mind if the classifier
   reserve stops being funding-independent.** The re-pricing equalises the two reserves, which
   is exact only because `classifierReserveNanoUsd` depends on the catalog and tier alone. The
   test's docblock states that dependency; a future reserve that reads the funding would silently
   weaken it.

## Confidence

**High.** The defect was reproduced at the brief's own figures before any edit (hold
89,263,685n, `runnable` `v/pin@64000 / v/cheap@65000 / v/dear@1022`, arrangement 119,967,135n),
both new tests were watched red for the right reasons, and the fix's effect is bounded by an
83,520-turn differential showing zero movement in the hold and in sendability with the presented
set narrowing in one direction only. The premise the change touches is now asserted rather than
argued, with a watched control. `turn-core.ts` is 100/100/100 with one dead branch deleted rather
than ignored, and the repo typechecks and lints clean.

**Medium** on nothing in the fix itself; the residual judgment is deviation 1 (candidate-only
scoping), which an auditor can overrule with a one-line change of which block each call site
passes.
