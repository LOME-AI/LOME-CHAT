# B3 — `getTurnOptions`: one producer, two sets — implementation report 5

## Objective

One Minor. The published contract for `ModelEntry.dimensions` still read "Every combination
inside is feasible", which is now deliberately false for a **pinned** row and — worse — invites a
consumer to read the one reading report 4's closure argument enumerates as the family's single
deliberate exception ("a pinned row's own-fit verdict, which no decision consumes"). The fix
states the two-kinds-of-row rule on the field itself: candidate rows are arrangement-graded and
decision-bearing; a pinned row carries an own-fit diagnosis no decision — the effort control
included — may read.

`docs/BILLING.md:826` carries the identical sentence and is founder-owned; it is queued for the
doc batch and was **not** edited. Verified it is the only other occurrence:
`grep -rn "Every combination inside is feasible"` over `*.ts|*.tsx|*.md` (node_modules excluded)
returns exactly `docs/BILLING.md:826` plus this run's own `plan.md:1989` and `ledger.md:3430`
statements of the finding — no source file repeats it.

**STOP-AND-ASK was evaluated and not triggered.** Stating the rule accurately needs no type-level
discriminator, because the distinction is already derivable by the consumer from the input it
supplied: a row is pinned iff the `Selection` named its `modelId` in `answerSources.models`, every
other row is a candidate, and the two sets are **disjoint by construction** —
`candidatePool = catalog.filter((m) => !pinnedIds.includes(m.modelId))` (`turn-core.ts:575`), so no
`modelId` appears as both kinds and the classification is total. My view on whether it *should* be
type-level is in Concerns 1; it is a contract change under Global Constraint 10 and therefore not
mine to make.

## Files changed

| File               | Why                                                                                                                              |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `turn-types.ts`    | The `ModelEntry.dimensions` docblock: the false sentence replaced by the two-kinds-of-row rule. Comment-only, proved below.        |
| `turn-core.test.ts` | One assertion (plus its comment) on the instance-3 fixture, pinning the divergence the new docblock describes. Test-only.         |

## The docblock, before and after

**Before** (`turn-types.ts:185`, one line):

```ts
  /** Per-dimension options for THIS model. Every combination inside is feasible. */
  readonly dimensions: readonly DimensionAvailability[];
```

**After:**

```ts
  /**
   * Per-dimension options for THIS model. Each option carries its own verdict; no
   * claim is made about combinations across dimensions.
   *
   * What a presented option MEANS depends on which of the two kinds of row this is,
   * and only one kind is decision-bearing:
   *
   * - a **candidate** row — a catalog model the selection did not pin — is graded
   *   against the whole arrangement it would create, the pinned siblings plus
   *   itself. A presented option is one that arrangement can honour, so the list is
   *   already capped by the tightest pinned sibling. This is what a classifier may
   *   pick and what a model picker greys from.
   * - a **pinned** row is graded on that sibling's own fit, because the sibling is
   *   already chosen and the row's job is to name which sibling is the problem. It
   *   is deliberately FINER than the turn's verdict: an option can be presented
   *   here while `turnDimensions` on the {@link OptionSet} greys it and pinning it
   *   refuses, because a sibling cannot honour it. Nothing may decide from it — an
   *   effort control reads `turnDimensions`, which ANDs over the pinned siblings
   *   inside an OR over the arrangements the turn could become.
   *
   * Telling the kinds apart needs no field on this type: a row is pinned iff the
   * {@link Selection} named its `modelId` in `answerSources.models`, every other
   * row is a candidate, and the two sets are disjoint. A selected id the catalog
   * cannot price carries no options at all.
   */
  readonly dimensions: readonly DimensionAvailability[];
```

Three deliberate choices in the wording:

1. **The combination claim is dropped, not corrected.** Grading is per option
   (`dimensionsFor` maps `grade(option.optionId)` over one dimension's options), so a joint claim
   across dimensions is not derived today and must not be published — the field would otherwise
   acquire a second false sentence the moment E4 adds media parameters as additive per-model
   dimensions.
2. **The prohibition names its alternative.** "Nothing may decide from it" would be an
   unenforceable request on its own; pointing the effort control at `turnDimensions` and stating
   the AND-inside-OR rule tells E1 what to read instead, which is the actual remedy.
3. **The classification rule is stated rather than implied**, because the finding is about a rule
   guarded only by prose: a reader who cannot tell which kind a row is cannot obey the rule.

## Confirmation: no executable line changed in `turn-types.ts`

Mechanically checked rather than asserted. I reconstructed the pre-edit file by substituting the
old one-line docblock back, stripped block and line comments from both versions, dropped blank
lines, and compared:

```
EXECUTABLE LINES IDENTICAL: True
executable line count: 88
```

No type, field, signature, export or value changed; `ModelEntry` is byte-identical in its
executable content, and `turn-core.ts` was not touched this cycle at all.

**The one executable change this cycle, exactly:** `turn-core.test.ts` lines 496–505 added inside
the existing `greys a rung one pinned sibling cannot honour, though its sibling can` test — a
4-line comment (496–499) and one `expect(rowRungsOf(menu, 'v/wide')).toEqual([...])` (500–505). No
existing line was modified or deleted; no production file other than the docblock changed.

## Tests added

| Test                                                             | Behaviour                                                                                        | Criterion                     |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------- |
| (assertion added to) `greys a rung one pinned sibling cannot honour, though its sibling can` | On the both-pinned fixture the `v/wide` **row** presents `off/low/medium/high` while the menu greys `medium/high` — the divergence the new docblock publishes | single derivation (the enumerated exception) |

**Why an assertion and not a new test.** The divergence is a property of the fixture the finding
itself cites; asserting it beside that fixture's menu expectation puts the row and the menu
verdicts in one place, which is the whole point being documented.

**It is a characterisation pin, labelled as such — it passed on first run.** It adds no behaviour;
it pins behaviour report 4's deviation 1 argued for and left unpinned in the *divergent* case
(`caps a candidate row's rungs by the tightest pinned sibling` pins pinned-row own-fit grading only
where it coincides with the arrangement's verdict). Because it could not be watched red for a
missing feature, it was **watched red under a control**: changing `entriesFor`'s pinned grader from
`siblingBlock` to `arrangementBlock` — the exact change that would delete the §Story 1.3 diagnosis
— reddens it at its own line,

```
-   "medium=enabled",            +   "medium=model_output_cap_too_low",
-   "high=enabled",              +   "high=model_output_cap_too_low",
  ❯ src/affordability/turn-core.test.ts:500
```

and predicted the four values exactly before the first run, so the docblock's central claim is
measured, not reasoned. `turn-core.ts` was restored from a pre-control copy and `diff` is clean —
byte-identical.

## Self-gate

| Command                                                                       | Result                                                              |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `npx turbo test --filter=@hushbox/shared --force`                              | **pass** — 124 files, 2,965 tests, coverage gate green               |
| `npx turbo typecheck --force --continue`                                       | **pass** — 16/16, zero cached                                       |
| `pnpm arch:check`                                                              | **pass** — 11 rules over 2,017 files                                 |
| `npx eslint src/affordability/turn-types.ts src/affordability/turn-core.test.ts` from `packages/shared`, after the last edit | **pass** — exit 0                    |

`turn-types.ts` and `turn-core.ts` both report **100 / 100 / 100 / 100** in the package coverage
table. The test total is unchanged from report 4 (2,965) because an assertion was added, not a
test.

`apps/api` was not re-run: this cycle changed one comment and one test assertion, both inside
`packages/shared/src/affordability`, and repo-wide typecheck is green over all 16 packages. Report
4's attribution of the 7 `notifications/domain/templates/template-html.test.ts` snapshot failures
(§Known Breakage's named `apps/api` entry) stands unchanged and untouched.

## Acceptance criteria

Reports 1–4 evidence stands. This cycle's delta is confined to the one criterion the finding
reaches:

- **"ONE derivation must feed all four presented-set readings"** — **still met**, and its closure
  argument's single enumerated exception is now correctly published rather than contradicted. The
  argument was: every decision-driving reading is a query over `siblingBlock` → `arrangementBlock`
  → `reachableAt`, with exactly one reading deliberately different (a pinned row's own-fit
  verdict, which no decision consumes). The type's own doc invited a consumer to consume it, which
  report 4 named as the shape of a sixth instance; the field now states the rule and names what
  an effort control must read instead.
- Every other criterion is untouched: no executable production line changed, so no measured figure
  in reports 1–4 moves (the 55,440-turn differential, the four pairwise-agreement pairs, the
  completeness biconditional and the hold property all re-ran green as part of the 2,965).

## Corrections to report 4

Both measured by the auditor, neither material, applied here so the record is accurate:

1. **The one-line revert reddens pair 3, not pair 4.** Report 4's Confidence section says
   "reverting it is one line — pass `siblingBlock` instead of `arrangementBlock` as the candidate
   rows' grader — and **pair 4** … will go red". Wrong pair: that coarse revert reddens **pair 3**
   (rows ↔ send gate) first. **Pair 4** (a row's rungs ↔ that row's verdict) is what the narrower
   **rung-only** revert reddens. Report 4's controls section states this correctly; only its
   Confidence section is wrong.
2. **The residual's bound is one classifier reserve, and ≈0.1¢ is not the bound.** Report 4 states
   the menu's conservatism on effort-only-open turns as "bounded by ≈0.1¢". The precise bound is
   **exactly one classifier reserve** (plus one `T`-quantum); ≈0.1¢ is only the figure for a
   realistic cheapest engine, and report 4's own deliberately expensive fixture makes it **0.65¢**.
   The direction and the reasoning are unchanged — §Reasoning Effort 3 permits conservatism, and
   closing it would require pricing every rung against a second set of arrangements.

## The durable reason instance 5 was worth fixing

Report 4 recorded instance 5 (a candidate row's rungs standing above what its arrangement honours)
as "structural, not live", with the unreachability proof, and flagged the fix as a Medium-confidence
judgment that widened the diff. The durable reason it was right is one the report did not give:
**the unreachability proof rests on requirements being arrangement-independent, and E4 is scheduled
to break that premise** when media parameters become additive per-model dimensions. The proof's
second branch is "that bound is arrangement-independent, so `P` blocks `e` in every arrangement" —
an additive per-model dimension makes a sibling's requirement depend on the arrangement, and the
over-stated ceiling becomes reachable. Fixing it converted an argument that was about to expire
into a structure. Recorded so a later reader does not re-litigate it as gratuitous scope.

## Deviations, with reasons

Reports 1–4 deviations stand. New:

1. **One test assertion was added on a cycle briefed as a comment fix.** The docblock's central
   claim — that a pinned row's rungs may diverge from the menu, deliberately — was documented
   nowhere executable in the divergent case, and a rule guarded only by prose is precisely what
   this finding is about. Test-only, cannot change behaviour, watched red under a control, and
   labelled a characterisation pin. If an auditor prefers the strictly comment-only diff, deleting
   lines 496–505 restores it exactly.

## Concerns and limitations

Reports 1–4 concerns stand, with concern 1's bound corrected above (one classifier reserve, not
≈0.1¢). New:

1. **Should the two-kinds distinction be type-level? My answer: not on `ModelEntry`, and not by a
   discriminator.** Adding `kind: 'pinned' | 'candidate'` would make the classification
   self-describing but would *not* make the rule structural — a consumer can still read
   `dimensions` on a pinned row, exactly as it can today, so the prohibition stays prose. The
   change that would make it structural is to stop publishing the diagnosis in the same shape as
   the decision: a pinned row would carry its blocking reason (which sibling, why) and **no
   `dimensions` list at all**, so "read a pinned row's rungs" becomes a compile error rather than a
   documented mistake. That is the right end state and it is a contract change under Global
   Constraint 10 with E1 as its first consumer — an orchestrator/founder call, not mine, and worth
   deciding **before** E1 builds against the current shape rather than after.
2. **`docs/BILLING.md` §Data Structures still publishes the false sentence** at line 826, verbatim.
   Founder-owned and queued for the doc batch, so untouched — noted only so the batch is not
   closed without it, since it is the copy a reader is most likely to hit first.
3. **The Lane C reserve-predicate ruling is closed, not open.** §Lane C now rules that the shared
   predicate is pool size, that C1/C2 must use the same one, and that a skipped call simply leaves
   the reserve unspent. That matches what B3's producer implements
   (`classifierIsBoughtForTurn` on `candidatePool.length`); nothing in B3 changes and I am not
   carrying it as an open item.
4. **`reasoning-plan.ts` still carries plan identifiers in comments** (`(G1)`, `(G3)`), forbidden by
   §Durable Naming. Pre-existing, outside my ownership, flagged not edited — unchanged from
   report 4.

## Confidence

**High.** The change is one docblock whose comment-only nature is mechanically proved (stripped
executable content identical, 88 lines), plus one test assertion whose four expected values were
predicted before the first run and which goes red under the exact regression it guards, with
`turn-core.ts` restored byte-identically afterwards. The full shared suite is 124 files / 2,965
tests green with the coverage gate satisfied and `turn-types.ts` at 100/100/100/100, repo typecheck
is 16/16, `arch:check` and lint on the edited files are clean, and no production behaviour could
have moved because no production executable line changed.
