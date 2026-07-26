# B3 — `getTurnOptions`: one producer, two sets — implementation report 4

## Objective

One validated defect and one root cause. The defect: `mergeTurnOption` **OR**s the turn-level
effort union over **pinned** siblings where §Turn Stories 2.1 requires an **AND**, so the menu
marks a rung available at every balance while pinning that rung is unsendable. The root cause:
the producer computed four views of "what is presented or possible" — per-row availability, the
turn-level dimension union, sendability, and the hold's `MAX` domain — and nothing structurally
forced them to agree. The new criterion asks for one derivation feeding all four, with pairwise
agreement pinned as a property, and for a search for a further member of the family.

Outcome: **one derivation, four readings, four defects closed (two of them found this cycle),
and the hold and the send gate provably unmoved across 55,440 turns.**

## Files changed

| File                            | Why                                                                                                                                                              |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `turn-core.ts`                  | One leaf predicate → one conjunction → one set; all four readings become queries over it. Deletes `mergeTurnOption`, `contributorsOf`, `candidateBlocks`, `blockingReason`, `Arrangement.viable`, `EntryContext` and `optionAvailability`'s own copy of the leaf. |
| `turn-core.test.ts`             | The AND/OR repro, its send-gate pairing, the three further repros, and the unpriceable-branch pin.                                                                 |
| `turn-options.agreement.test.ts` | New: the pairwise-agreement properties as a sweep, measured through the producer.                                                                                 |
| `turn-options.property.test.ts` | One docblock only: the premise it described (the union's contributors are the runnable entries) is no longer how the union is derived, and a stale comment is worse than none. |

No exported signature changed: `turn-core` is on no barrel, `turn-types.ts` and `turn-options.ts`
are untouched apart from that docblock, and `CoreResult`/`OptionSet`/`ModelEntry` are unchanged.
A repo-wide search for `turn-core`, `turn-options`, `turn-arithmetic`, `turn-types` and
`getTurnOptions` outside `packages/shared/src/affordability/` still finds no source consumer
(Global Constraint 10 re-checked this cycle: only build artefacts match), and repo-wide typecheck
is 16/16.

## The one derivation

```
siblingBlock(model, arrangement, context, effort)   ← THE leaf: why one sibling cannot answer
arrangementBlock(arrangement, context, effort)      ← the conjunction over its siblings
reachableAt(presented, context, effort)             ← { running, blocks } over what the turn could become
presentedArrangements(plan, pinned, candidates)     ← the MAX-over-candidates / Σ-over-siblings shape, once
```

The four readings, each now a query:

| reading                | before                                                       | now                                              |
| ---------------------- | ------------------------------------------------------------ | ------------------------------------------------ |
| send gate              | `selectedBlocks` from rows + `viableCandidates.length === 0`  | `reachable.running.length > 0`                   |
| hold `MAX` domain      | `smartSlot ? worstOf(viableCandidates) : pinnedArrangement`   | `worstOf(reachable.running)`                     |
| candidate row + rungs  | `arrangement.viable` (row) and `feasible(m, e, ceiling)` (rungs) | `arrangementBlock(A(c), ·)` at the pin and at each rung |
| turn-level menu        | rows' options merged, available-wins                          | `reachableAt(presented, ·, rung)` per rung        |

Two things that look like scope creep are the substance of the change. `Arrangement.viable` was
an inline second copy of the leaf predicate (`!gate.resolvable || !feasible(...)`) living beside
`siblingBlock`, which computed the same predicate to produce a reason; `optionAvailability` was a
third copy (`feasible` + `boundReason` + `requiredCeilingTokens`, minus the resolvability step).
Both are gone. What replaced the second is the `RowGrader` — a row's verdict is `grade(pin)` and
each of its rungs is `grade(rung)`, so the two cannot disagree because they are one function at
different arguments.

Deleting the row-merged union also removes the union's dependence on `runnable`, so its rows are
now funding-independent: the menu's rungs come from the presented arrangements' membership, which
the selection fixes.

## The AND/OR repro, shown passing

Fixture: `v/wide` (cap 64,000 — High's 32,768-token budget fits beside an answer) and `v/narrow`
(cap 9,000 — Low's 4,096 fits, Mid and High clamp to 9,000 and cannot), both **pinned**, no smart
slot, effort open, funding 1,000,000,000n, tier `paid`. Money binds on neither rung, so the
fixture isolates the quantifier.

| rung   | menu before | pin sends? | menu after                 |
| ------ | ----------- | ---------- | -------------------------- |
| off    | enabled     | yes        | enabled                    |
| low    | enabled     | yes        | enabled                    |
| medium | **enabled** | **no** (`model_output_cap_too_low`) | `model_output_cap_too_low` |
| high   | **enabled** | **no** (`model_output_cap_too_low`) | `model_output_cap_too_low` |

Pinned as `greys a rung one pinned sibling cannot honour, though its sibling can`. Red first:

```
- "medium=model_output_cap_too_low"   - "high=model_output_cap_too_low"
+ "medium=enabled"                    + "high=enabled"
```

**The turn-level union asserted against the send gate for a pinned selection — the pairing that
was missing** — is `enables exactly the rungs a pin of that rung can send`: the same selection is
re-produced with each rung pinned and the menu's verdict compared against `sendable`, on one
call's menu. Red first at `medium=true`/`high=true` against `medium=false`/`high=false`.

The existing `sends a heterogeneous selection at exactly the rungs its own menu enables` did not
catch this because its second sibling has no ladder at all, so the AND over pinned siblings is
vacuous there and equals the OR. Two *reasoning* siblings with different caps is the shape that
separates them.

## The pairwise-agreement property, and its pre-fix red

`turn-options.agreement.test.ts` sweeps 200 generated (funding, basis, selection, tier) draws on
a five-model catalog and asserts four pairs on **both** arms (`affordable` and `admissible`),
every one measured through the producer — the same turn re-produced with a rung pinned — so
nothing re-implements pricing to check pricing:

1. **union ↔ send gate.** Every rung the menu enables must be sendable when pinned (§Reasoning
   Effort 3). Universal. On the reserve-invariant shape it is a strict biconditional and the
   greyed rung must carry **the reason the send gate would give**.
2. **send gate ↔ hold.** `holdNanoUsd !== undefined` iff `admissible.sendable`.
3. **rows ↔ send gate.** The turn sends iff every selected row is available and, with a smart
   slot, some candidate row is.
4. **a row's rungs ↔ that row's verdict.** A rung is presented on a row iff pinning that rung
   leaves the row presented.

Controls, all asserted: >100 enabled rungs, >100 greyed rungs, >50 reason comparisons, >500 rung
comparisons, >20 reserve-invariant draws, >20 unsendable draws, >20 smart-slot-beside-pinned
draws.

**Failure against the current code, before the fix:**

```
× the four readings agree pairwise
  AssertionError: expected 'affordable:medium:false' to be 'affordable:medium:true'
```

— the menu enabling `medium` while pinning `medium` refuses, on the first violating draw.

Property 4 passed on first run once properties 1–3 were green, so it was **watched under a
control**: reverting only the rung grading to the pre-fix own-fit predicate (leaving row verdicts
arrangement-graded) turns it red at its own line —
`expected 'affordable:v/dear:off:true' to be 'affordable:v/dear:off:false'`. A coarser control
(reverting the whole candidate grader) reddens property 3 first, which is why the narrow one was
used. `turn-core.ts` was restored byte-identically afterwards (`diff` clean against a pre-control
copy).

**Why property 1 is universal in one direction only, stated so nobody "fixes" it later.** Pinning
a rung closes the effort dimension, and on a turn whose *only* open dimension is effort that drops
the classifier reserve — so the pinned turn solves a slightly larger shared token count and a
money-bound rung the menu greyed can become sendable. The menu is therefore conservative by at
most the reserve (≈0.1¢), which is the safe direction: §Reasoning Effort 3 forbids enabling what
the server refuses, not the reverse, and `presented ⟺ feasible` is scoped to *this* turn's
ceiling. Closing it would require pricing every rung against a second set of arrangements — the
two-pricings hazard this task exists to remove. With a smart slot over ≥2 candidates the model
dimension keeps the reserve bought either way, which is exactly the `reserveIsPinInvariant` shape
the strict half runs on.

## The search for a further instance

**What I looked at.** Every place in the producer that answers "what is presented or possible":
`turnRefusal`, `holdArrangement`, `entriesFor`, `entryFor`, `optionAvailability`, `dimensionsFor`,
`turnDimensionsFor`/`mergeTurnOption`, `contributorsOf`, `candidateBlocks`, `blockingReason`,
`priceArrangement`'s inline `viable`, and `classifierIsBoughtForTurn`. For each I asked which of
the four readings it feeds and whether a second derivation of the same question exists.

**Found and fixed — instance 4: the menu greys rungs the send gate would accept.** The mirror of
instance 3, from the same row-merged union. A row the turn cannot run greys *every* rung it
offers, so a single-model turn pinned above its cap greys `off` and `low` too — while pinning
`low` sends. Measured before the fix: `v/narrow` with `high` pinned, menu
`off=model_output_cap_too_low low=model_output_cap_too_low …`, `pinned-low` → sendable. That is a
payer told there is no way to send when there is one, on the commonest shape in the system. Pinned
as `keeps offering the rungs a lower pin could send when the pinned rung refuses`, red first.

**Found and fixed — instance 5: a candidate row's rungs stood above what its arrangement
honours.** §Story 2.2 defines a candidate's effort ceiling as "its highest feasible level after
per-model resolution, **capped by the tightest pinned sibling**"; the code graded it on the
model's own fit. That annotation is what §Reasoning Effort 8 clamps a classifier answer onto, so
an over-stated ceiling clamps a joint (model, effort) pick onto a rung a pinned sibling has no
answer room for — which is how §Story 2.8's "an effort is enabled iff at least one candidate can
honour it, **and pinning that effort culls the candidate set to those that can**" composes to
exact coverage: the per-candidate ceiling is the cull. Pinned as `caps a candidate row's rungs by
the tightest pinned sibling`, red first.

**Honest framing of instance 5: it was structural, not live.** I could not construct a reachable
harmful pick, and the reason is worth recording because it is the argument the structure now
replaces. A pinned sibling `P` blocks rung `e` inside `A(c)` either through the shared token count
`T` or through its own cap/headroom. If through `T`: `T < target(e) + 1000`, and for `c` to fit
`e` at that `T` its own budget must be clamped by its cap, which makes `required(c, e) = cap_c +
1000 > cap_c ≥ ceiling` — a contradiction, so `c` fails too and there is no disagreement. If
through cap/headroom: that bound is arrangement-independent, so `P` blocks `e` in *every*
arrangement and the (correctly AND'd) menu greys `e` turn-wide, leaving the over-stated ceiling
unreachable. So today the over-statement is confined to rungs no one can choose. I fixed it
anyway: that argument is precisely the kind of asserted agreement this cycle exists to convert
into a structural one, it rests on requirements being arrangement-independent (an additive
per-model dimension would break it), and collapsing it deleted the third copy of the leaf
predicate.

**Also closed, from the same root cause:** report 2's concern 3 — `turnDimensions` was empty on an
unsendable smart-slot-only turn, because no model contributed to the union. The menu's rows now
come from the presented arrangements, so the fully-greyed picker the post-implementation amendment
asked for has rows to draw. Pinned as `carries the rungs its candidates offer on an unsendable
smart-slot turn`, red first (`expected [] to deeply equal [ 'off=insufficient_funds', … ]`).

**The argument that closes the family.** The family is *decision-driving readings computed by more
than one derivation*. After this change every decision-driving reading — what the classifier may
pick (candidate rows and their rungs), what the user may pick (the menu), what the server admits
(the send gate), what money is reserved (the hold's `MAX`) — is a query over `siblingBlock`
composed once into `arrangementBlock` and once into `reachableAt`. There is no second predicate to
drift from, no cached verdict beside the data, and the menu no longer reads the rows. Exactly one
reading is deliberately different: a **pinned row's** own-fit verdict, which no decision consumes
— the pinned siblings are not chooseable, the union does not read them, and its only job is to
name which sibling is the problem. That single exception is enumerated, and it is the one place a
future reader may find a row and the menu disagreeing without it being a defect. Its being read by
anything is what a fourth instance would look like.

## What moved, and what did not

A differential over **55,440 turns** (6 pinned-model sets × slot on/off × 7 effort pins × 4 tiers
× 6 basis lengths × 30 fundings, on a 6-model catalog, web search toggled), run against a
reconstruction of the pre-fix derivation in the same process. The reconstruction's fidelity is
itself controlled: it reproduces the pre-fix menu (`off=y,low=y,medium=y,high=y`) where the
current code produces the fixed one.

| quantity                                          | turns changed |
| ------------------------------------------------- | ------------- |
| `holdNanoUsd` / the priced total                  | **0**         |
| sendable + refusal code                           | **0**         |
| row verdicts, reasons and ceilings                | **0**         |
| the `runnable` list                               | **0**         |
| per-row rungs                                     | 34,854 (intended — instances 4, 5) |
| the turn-level menu                               | 28,412 (intended — instances 3, 4) |

26,873 of the 55,440 turns were sendable, so the zeros are measured on a matrix that reaches the
paths in question rather than on refusals.

**The STOP-AND-ASK condition is not triggered.** What the hold is taken over did not change: the
`MAX` domain was `viableCandidates` and is now `reachable.running`, and those are the same set by
construction — `arrangementBlock(a, pin) === undefined` iff every sibling was resolvable and
feasible, which is exactly what `viable` computed. For a turn without a smart slot the single
presented arrangement is the pinned one, read only when the turn is sendable, which is the same
condition as before. The differential's zero over 55,440 turns is the measurement of that
argument.

**The refusal codes are unchanged for a structural reason too**, since `turnRefusal` now reduces
the presented arrangements' blocks rather than the pinned rows' plus the candidates': adding a
sibling only lowers `T`, so a block inside `A(c)` is never later in `REFUSAL_CODES` than the same
sibling's block inside the pinned arrangement, and `refusalPrecedence` is a minimum over that
order. Measured at 0 of 55,440 rather than left as prose.

## The two monotonicity premises

**Premise A — "∃ viable candidate" is monotone because each candidate arrangement has fixed
membership.** Unchanged and still holds: membership is still `pinned + candidate`, fixed by the
selection.

**Premise B — the union was safe only because `mergeTurnOption` preferred an available option, so
extra contributors could only add availability.** **Eliminated, not re-asserted.** The union no
longer reads `runnable` or any row; it ranges over the presented arrangements, whose membership no
funding number moves, and each one's verdict is monotone in `(funding, basis)`. The turn-level
assertion report 3 added to `expectSubset` still passes and now guards the replacement premise; its
docblock was corrected to describe it, because the old text named a mechanism that no longer
exists.

## Tests added

| Test                                                                                | Behaviour                                                                        | Criterion |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | --------- |
| `greys a rung one pinned sibling cannot honour, though its sibling can`               | AND over pinned siblings (§Story 2.1), on two reasoning siblings                  | instance 3 |
| `enables exactly the rungs a pin of that rung can send`                              | menu ⟺ send gate on one call's menu (§Reasoning Effort 3)                        | instance 3 |
| `keeps offering the rungs a lower pin could send when the pinned rung refuses`        | the menu does not grey the rung that would unblock the payer                      | instance 4 |
| `carries the rungs its candidates offer on an unsendable smart-slot turn`             | the unsendable arm has rows to grey                                              | instance 4 / report 2 concern 3 |
| `caps a candidate row's rungs by the tightest pinned sibling`                         | §Story 2.2's per-candidate ceiling; pinned rows keep their own-fit diagnosis      | instance 5 |
| `keeps a candidate row's lower rungs when the pinned rung makes the row unavailable`  | a rung is graded on its merits, not by inheriting the row's reason                | instance 5 |
| `refuses a selection naming an unpriceable model even when its siblings fit`          | characterisation pin (see below)                                                  | single derivation |
| `the four readings agree pairwise` (new file)                                         | the four pairwise properties, both arms, 200 draws, through the producer          | single derivation |

**One of those was not TDD-red and is labelled as such.** `refuses a selection naming an
unpriceable model even when its siblings fit` passed on first run: it pins behaviour the refactor
had to preserve and covers the branch `turnRefusal` grew (something runs *and* a selected id is
unpriceable). It is a characterisation pin, not evidence of new behaviour; the differential is
what proves that path unchanged.

## Self-gate

| Command                                                                                                    | Result                                                        |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `npx turbo test --filter=@hushbox/shared --force`                                                           | **pass** — 124 files, 2,965 tests, coverage gate green         |
| `npx turbo typecheck --force --continue`                                                                    | **pass** — 16/16, zero cached                                  |
| `pnpm arch:check`                                                                                          | **pass** — 11 rules over 2,017 files                           |
| `eslint turn-core.ts turn-core.test.ts turn-options.agreement.test.ts turn-options.property.test.ts` from `packages/shared`, after the last edit | **pass** — exit 0 |
| `npx turbo test --filter=@hushbox/api`                                                                     | 1 file / 7 tests fail (465 files, 6,391 tests pass) — pre-existing, attributed below |

`src/affordability` reports **100 / 100 / 100 / 100** (statements / branches / functions / lines)
in the package coverage table, with no new `v8 ignore`.

### `apps/api`, attributed

`notifications/domain/templates/template-html.test.ts` — 7 snapshot failures, 465 files passed, 1
skipped, 6,391 tests passed. Not mine, on the same grounds as the previous two cycles and
re-checked this one: it is §Known Breakage's named `apps/api` entry, the counts are identical to
both earlier cycles, `git diff --stat HEAD` over that template directory is empty, this task
touched no file under `apps/api`, nothing under `apps/api` imports the modules I changed, and
repo-wide typecheck is green over all 16 packages. I checked for the second-cause hazard the
Known-Breakage list warns about: the failing file, test names and count match the entry as
written, and my change cannot reach a template.

`pnpm test:web` and the marketing suite were not re-run: no file outside
`packages/shared/src/affordability/turn-*` changed, nothing imports those modules, and repo-wide
typecheck is green.

## Acceptance criteria

Reports 1–3 evidence stands except where this cycle moved it. Deltas only:

- **"ONE derivation must feed all four presented-set readings"** — **met.** All four are queries
  over `siblingBlock` → `arrangementBlock` → `reachableAt`; the second and third derivations
  (`Arrangement.viable`, `optionAvailability`'s own predicate) and the divergent union
  (`mergeTurnOption` + `contributorsOf`) are deleted rather than reconciled. The correct rule —
  AND over pinned siblings, OR over runnable candidates — is not written anywhere: it falls out of
  a conjunction over an arrangement's siblings inside a disjunction over the arrangements.
- **"pin PAIRWISE AGREEMENT as a property rather than a spot check"** — **met**, four pairs, both
  arms, 200 draws, with pre-fix red evidence and a watched control for the pair that passed first.
- **"The hold must cover every arrangement a PRESENTED candidate can create"** — **still met**,
  unchanged from report 3, and the property that pins it still passes. The hold did not move on
  any of 55,440 turns.
- **Completeness `presented == feasible` over the `admissible` set** — **met.** The completeness
  fixture's biconditional passes unmodified; it is now also covered from the other side by pair 4,
  which states it through the producer rather than through a re-derived `wouldFit` and therefore
  reaches the effort-pinned turns the completeness fixture (which never pins effort) cannot see.
- **`admissible ⊆ affordable` per model and per option** — **met**, unchanged assertions, and the
  premise underneath the turn-level half is now structural rather than argued.
- **Options are marked, never filtered** — **met.** Nothing was removed from `all` or from any
  option list; the 150-draw sweep still asserts every catalog model and every offered rung on both
  arms.

## Deviations, with reasons

Reports 1–3 deviations stand, including report 3's accepted deviation 1. New or restated:

1. **Pinned rows keep their own-fit verdict AND their own-fit rungs; candidate rows are
   arrangement-graded in both.** The single-derivation requirement did **not** force pinned rows to
   change, because the union no longer reads them — which is what made report 3's deviation safe
   rather than merely argued. Extending arrangement grading to pinned rows would make every pinned
   row show the same rung verdicts as the menu, deleting the "which sibling is the problem"
   diagnosis §Story 1.3 wants surfaced, for no decision-side gain.
2. **Instance 5 was fixed although I could not construct a reachable harmful pick** (proof above).
   Recorded because the auditor should judge it as hardening plus a duplication deletion, not as a
   live-bug fix.
3. **Rung availability no longer inherits an unavailable row's reason.** That inheritance is what
   made instance 4 visible at row level. It was invisible to the completeness fixture because that
   fixture leaves effort open, where a row's verdict is already the cheapest-corner verdict and an
   unavailable row genuinely has no available rung.
4. **`turn-options.property.test.ts` was edited** — one docblock, no assertion. Listed because it
   is a file outside this cycle's minimal blast radius; leaving a comment describing a deleted
   mechanism would be a wrong comment at file scale.

## Concerns and limitations

Reports 1–3 concerns stand except: report 2's concern 3 (`turnDimensions` empty on an unsendable
slot-only turn) is **closed**, and report 3's concern 1 (the AND/OR inversion) is **closed**.
Report 2's concern 2 (a pinned sibling's presented ceiling is optimistic while a slot is
unresolved) remains the only presentation-side optimism, and report 2's concerns 1, 4, 5 and
report 1's 1–4, 7, 8 are unchanged.

New this cycle:

1. **The menu is conservative by the classifier reserve on turns whose only open dimension is
   effort** (analysed above). Pre-existing, bounded by ≈0.1¢ and one `T`-quantum, in the direction
   §Reasoning Effort 3 permits. Closing it requires a second pricing of every arrangement per
   rung, which is the hazard this task removed; if a founder wants the menu exact there, the
   change belongs in what the reserve predicate reads, not in the menu.
2. **Cost.** The menu now evaluates the leaf predicate once per rung per presented arrangement
   instead of reusing the rows' options: ~6× the per-sibling gate work over the candidate pool.
   Pure integer and map work with no allocation of arrangements (pricing is untouched); the
   affordability suite's 1,307 tests, including three sweeps, still run in ~2s. Worth knowing
   before someone puts a 300-model catalog through it per keystroke — the mitigation, if ever
   needed, is memoising `dimensionSupportFor` per model, not restoring a second derivation.
3. **`reasoning-plan.ts` still carries plan identifiers in comments** (`(G1)`, `(G3)`) — §Durable
   Naming forbids them. Pre-existing, outside my ownership, flagged not edited.

## Confidence

**High.** Four defects were reproduced at measured figures before any edit and watched red for the
right reasons; the fix is a deletion of three competing derivations rather than an added rule; the
whole affordability suite (48 files, 1,307 tests) passes with no test weakened and only one
docblock corrected; and a 55,440-turn differential against a fidelity-controlled reconstruction
shows the hold, the send gate, the row verdicts and the `runnable` list byte-identical, with
movement confined to the two readings the criterion asked to change. `src/affordability` is
100/100/100/100 with no new ignore, repo typecheck is 16/16, `arch:check` and lint are clean.

**Medium** on one judgment: fixing instance 5 without a reachable harmful pick widens the diff
beyond the two menu defects. If an auditor prefers the narrower fix, reverting it is one line —
pass `siblingBlock` instead of `arrangementBlock` as the candidate rows' grader — and pair 4 of
the agreement property is the test that will go red to prove the revert.
