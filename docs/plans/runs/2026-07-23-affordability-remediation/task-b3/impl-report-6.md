# B3 — `getTurnOptions`: one producer, two sets — implementation report 6

## Objective

New scope, not a fix cycle: make the two-kinds-of-row rule **structural**. A **candidate** row is
arrangement-graded, decision-bearing and carries `dimensions`; a **pinned** row carries
`availability` with its reason and **no `dimensions` at all**, so consuming a pinned sibling's
own-fit per-option diagnosis as a decision is a compile error rather than a documented mistake.

`docs/BILLING.md` §Data Structures is founder-owned and joins the doc batch; not edited. The
`BILLING.md:826` sentence ("Every combination inside is feasible") is still false and still queued —
re-verified this cycle as the only remaining occurrence outside this run's own `plan.md`/`ledger.md`.

## The shape

```ts
interface ModelEntryBase {                 // modelId · availability · ceilingTokens
export interface PinnedModelEntry extends ModelEntryBase { readonly kind: 'pinned' }
export interface CandidateModelEntry extends ModelEntryBase {
  readonly kind: 'candidate';
  readonly dimensions: readonly DimensionAvailability[];
}
export type ModelEntry = PinnedModelEntry | CandidateModelEntry;
```

`kind` is present **in addition to** removing `dimensions`, not instead of it. The ruling's
objection was to a discriminator that left `dimensions` readable on both arms; with the field gone
from the pinned arm the discriminator is what a consumer narrows on to reach a candidate's rungs at
all — `entry.kind === 'candidate' ? entry.dimensions : …`. It also replaces prose the old docblock
needed: the previous type told a reader to classify a row by cross-referencing
`Selection.answerSources.models`; now the row says which kind it is, so there is one authority
instead of a derivation every consumer repeats.

A selected id the catalog cannot price is a **pinned** row (`kind: 'pinned'`, `availability:
model_not_priceable`, `ceilingTokens: 0`): the user named it, and it carries no option list — which
it also did not before, now by type rather than by an empty array.

`ceilingTokens` stays on the pinned arm. §Story 1.5 and §The four notions both read a sibling's
presented ceiling, and the ruling scoped the removal to `dimensions`.

## Proof the mistake is now a compile error

**Before (the read compiled).** The new type-level pin's `@ts-expect-error` was *unused* against the
old type — TypeScript's own statement that reading a pinned row's rungs type-checked:

```
src/affordability/turn-types.test.ts(85,5): error TS2578: Unused '@ts-expect-error' directive.
src/affordability/turn-types.test.ts(59,5): error TS2353: … 'kind' does not exist in type 'ModelEntry'.
src/affordability/turn-core.test.ts(405,23): error TS2339: Property 'kind' does not exist on type 'ModelEntry'.
```

**After — the exact deleted cycle-4 code, re-added verbatim and shown failing.** The retired pin read
a pinned row's rungs through `rowRungsOf`, which found the entry on `all` and flattened
`entry.dimensions`. Re-added unchanged, that helper no longer compiles:

```
src/affordability/turn-core.test.ts(1017,20): error TS2339: Property 'dimensions' does not exist on type 'ModelEntry'.
  Property 'dimensions' does not exist on type 'PinnedModelEntry'.
```

The probe was removed afterwards and the test file restored byte-identically (`diff` clean). Note the
error names the pinned arm explicitly: the union read fails, and it keeps failing however the
consumer reached the row — `all`, `runnable`, or a bare `ModelEntry` parameter.

Six consumer sites failed this way when the type landed (listed under the sweep); every one was a
place a future surface could have made the same mistake.

## Files changed

| File                             | Why                                                                                                                          |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `turn-types.ts`                  | `ModelEntry` split into the two arms; the rule moves from a docblock into the shape.                                          |
| `turn-core.ts`                   | `entryFor` + injected grader → `pinnedEntryFor` (own fit, no rungs) and `candidateEntryFor` (arrangement-graded, with rungs); unpriceable rows typed pinned; `RowGrader`'s doc narrowed to the candidate row. |
| `turn-types.test.ts`             | The compile-time pin: narrowing reaches rungs, an un-narrowed read is `@ts-expect-error`.                                     |
| `turn-core.test.ts`              | `SLOT_ONLY`/`candidateOf` helpers; the two-kinds shape pins; the pinned-sibling diagnosis pin; two rung tests retargeted to a candidate row; two pinned-rung assertions retired. |
| `turn-options.property.test.ts`  | Per-option subset and rung-completeness scoped to candidate rows, with a new `rowsWithRungs` control; one pinned-row rung assertion retargeted to the turn menu. |
| `turn-options.agreement.test.ts` | Pair 4 (a row's rungs ↔ that row's verdict) iterates the candidate rows.                                                      |
| `turn-options.completeness.test.ts` | `checkEntry` takes a candidate row; the shrinking-ceiling fixture makes the ladder model a candidate.                     |
| `turn-options.re-partition.test.ts` | Compiler-only fallback literal is a pinned row (the fixture pins the model).                                              |

## The consumer sweep (Global Constraint 10)

Repo-wide grep for `ModelEntry`, `.dimensions`, and every importer of `turn-types` / `turn-options` /
`turn-core`, across `packages`, `apps`, `scripts`, `e2e`, `apps/marketing`, `apps/admin`:

| Consumer                                            | Disposition                                                                   |
| --------------------------------------------------- | ----------------------------------------------------------------------------- |
| `turn-core.ts` (producer)                           | Rewritten: two builders. Only production consumer.                            |
| `turn-core.test.ts`                                 | 3 sites fixed (helper + 2 retargeted tests).                                  |
| `turn-options.property.test.ts`                     | 2 sites fixed.                                                                |
| `turn-options.completeness.test.ts`                 | 2 sites fixed.                                                                |
| `turn-options.agreement.test.ts`                    | 1 site fixed.                                                                 |
| `turn-options.re-partition.test.ts`                 | 1 site fixed (type-only fallback).                                            |
| `apps/web`, `apps/api`, `apps/admin`, `apps/marketing`, `scripts/`, `e2e/` | **Nothing.** No file outside `packages/shared/src/affordability/` imports any `turn-*` module, and `affordability/index.ts` does not export `turn-types` or `turn-options` — the public surface is B8's. |
| `SelectedModelEntry`, `StartModelEntry`, `DoneModelEntry`, `publicModelEntrySchema` | Unrelated same-suffix names in the web store, SSE schemas and the catalog fetch. No relationship to this type; untouched. |

**So B6, B7, E1 and E4 inherit a known surface**, and it is this: read `turnDimensions` for what the
turn can run; read a **candidate** row for what may fill the smart slot and up to what ceiling
(§Story 2.2's annotated list); read a **pinned** row's `availability` for which sibling is the
problem. A row is classified by `kind`, never by re-deriving it from the `Selection`. Nothing
consumed `dimensions` outside this module before the change — confirmed, which is exactly why the
change was cheap today and would not have been after E1.

## The characterisation pin from cycle 4

**Retired to the type, and replaced at the granularity the type still permits — both, deliberately.**

- Cycle 4's pin asserted a *pinned* row presents four rungs while the menu greys two. Its subject no
  longer exists, so the assertion is deleted rather than weakened; what it documented — that a
  pinned row's own-fit verdict may diverge from the turn's — is now the `@ts-expect-error` pin in
  `turn-types.test.ts`, checked by `typecheck` instead of by a runtime comparison.
- The same claim survives **behaviourally** one level coarser, and it had to, because otherwise
  nothing local would fail if pinned rows were switched to arrangement grading: new test
  `names the pinned sibling that blocks the turn, leaving the sibling that fits available` — the turn
  refuses at `high`, `v/narrow` carries `model_output_cap_too_low`, and `v/wide` stays **available**.
  That is §Story 1.3's "which sibling is the problem", now pinned on the row's `availability`.
- The second pinned-row rung assertion (in `caps a candidate row's rungs by the tightest pinned
  sibling`) is deleted for the same reason; that test's candidate-side assertion, which is the one
  the criterion is about, is untouched.

The replacement passed on first run, so it was **watched red under a control**: changing
`pinnedEntryFor`'s grader from `siblingBlock` to `arrangementBlock` — the exact regression it guards —
reddens it at its own line,

```
- "v/wide=available",   + "v/wide=model_output_cap_too_low",
❯ src/affordability/turn-core.test.ts:558
```

and `turn-core.ts` was restored byte-identically afterwards (`diff` clean against a pre-control copy).

## The hold, the send gate, row verdicts and `runnable` are unmoved — measured

A **15,288-turn** differential in one process against a reconstruction of the pre-change producer
(7 pinned sets including an unpriceable id × slot on/off × 7 effort pins × 4 tiers × 2 basis lengths
× 21 fundings, web search toggled, 5-model catalog; 5,638 turns sendable):

| quantity                                             | turns changed |
| ---------------------------------------------------- | ------------- |
| `totalNanoUsd` (the hold) and the full line-item manifest | **0**     |
| `sendable` and the refusal code                       | **0**         |
| every row's `availability`, its reason and `ceilingTokens` | **0**     |
| `runnable` membership and order                       | **0**         |
| `turnDimensions` (the turn-level menu)                | **0**         |
| pinned rows' option lists                             | 21,168 removed (the intended change) |
| candidate rows' option lists                          | 57,624 compared, all byte-identical |

The differential's own fidelity is controlled: changing the reconstruction's pinned grader by one
line makes it fail on the row comparison, so it is a live comparison rather than two aliases of the
same code path. Both probe files were deleted afterwards (no `*.probe.*` remains in the tree).

## Tests added

| Test                                                                              | Behaviour                                                                     | Criterion |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | --------- |
| `gives a pinned row its own verdict and no per-option list`                        | The produced pinned row is exactly `{kind, modelId, availability, ceilingTokens}` | the amendment |
| `gives a candidate row the per-option list a decision reads`                       | The candidate row carries `kind: 'candidate'` and every offered rung           | the amendment |
| `reaches a per-option list only after narrowing to the decision-bearing kind`      | Narrowing on `kind` is the only route to rungs                                 | the amendment |
| `does not publish a pinned row's own-fit option verdicts to any consumer`          | The un-narrowed read is a compile error (`@ts-expect-error`, checked by `typecheck`) | the amendment |
| `names the pinned sibling that blocks the turn, leaving the sibling that fits available` | §Story 1.3's diagnosis at row level; replaces the retired cycle-4 pin    | the amendment |

Red evidence: the two shape pins failed at runtime for the right reasons (`dimensions` present as an
extra key on the pinned row; `kind` `undefined` on the candidate row) and the two type pins failed
`tsc` with `TS2578`/`TS2353`/`TS2339` as quoted above. The fifth was watched red under the control
above.

## Self-gate

| Command                                                                          | Result                                                    |
| -------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `npx turbo test --filter=@hushbox/shared --force`                                 | **pass** — 124 files, 2,970 tests, coverage gate green     |
| `npx turbo typecheck --force --continue`                                          | **pass** — 16/16, zero cached                              |
| `pnpm arch:check`                                                                | **pass** — 11 rules over 2,017 files                       |
| `npx eslint` over all 8 changed files, from `packages/shared`, after the last edit | **pass** — exit 0                                         |

`turn-types.ts` and `turn-core.ts` both report **100 / 100 / 100 / 100** with no new `v8 ignore`. The
affordability suite is 48 files / 1,312 tests. `apps/api` and `apps/web` were not re-run: nothing
outside `packages/shared/src/affordability/` imports these modules (sweep above) and repo-wide
typecheck is green over all 16 packages, which is the gate Global Constraint 10 names for a shared-type
change.

## Acceptance criteria

Reports 1–5 evidence stands; this cycle touches one clause and adds the amendment.

- **The amendment — "a pinned row carries `availability` with its reason and no `dimensions`"** —
  **met.** Proved as a compile error, not as a convention; the produced shapes are pinned by two
  runtime tests; six consumer sites were forced to narrow.
- **"ONE derivation must feed all four presented-set readings"** — **still met, and the last prose
  guard in the family is gone.** Report 4's closure argument had exactly one enumerated exception (a
  pinned row's own-fit verdict, which no decision consumes) held in place by a docblock. The
  exception still exists — deliberately, it is the diagnosis — but "no decision consumes it" is now
  enforced by the type rather than asserted. The four decision-driving readings are unchanged, and
  the differential shows all four byte-identical.
- **`OptionSet` carries `runnable: NonEmpty` beside `all`, no hold field** — unchanged; `runnable`
  and `all` still carry `ModelEntry`, now the union.
- Every other criterion is untouched: no pricing, gate, refusal, ceiling or menu behaviour moved on
  any of 15,288 turns.

## Deviations, with reasons

Reports 1–5 deviations stand (report 5's added assertion is accepted and is retired here as
described). New:

1. **`kind` was added, which the ruling did not require.** Reasons above: it is the narrowing
   mechanism, it lets a consumer select the candidate rows, and it deletes the classify-by-Selection
   derivation the old docblock prescribed. Without it a consumer would narrow with
   `'dimensions' in entry`, which is a smell rather than a contract.
2. **Two pinned-row rung assertions were deleted and one retargeted to `turnDimensions`.** Their
   subject no longer exists; the surviving claims are re-pinned as described, and one
   (`never greys a rung in the picker that the send gate offers`) now reads the turn-level menu,
   which is what an effort control reads for a pinned sibling.
3. **Two `turn-core.test.ts` fixtures switched from a pinned model to a slot-only selection** so the
   subject model is a candidate. Chosen because the candidate-alone and pinned-alone arrangements
   have identical membership and (verified) identical classifier reserve on those fixtures, so the
   rung verdicts asserted are the same numbers; the tests pass unmodified in their assertions. Same
   technique in the completeness fixture (`LADDER_AS_CANDIDATE`).
4. **The per-option half of `admissible ⊆ affordable` now binds on candidate rows only.** Pinned
   rows have no per-option data to compare; they remain constrained at row level (availability and
   ceiling, both still swept). Not a weakening — the subject was deleted, and a new
   `rowsWithRungs > 100` control proves the rung sweep still inspects rows rather than silently
   passing over an empty set.

## Concerns and limitations

Reports 1–5 concerns stand, minus the one this cycle closes (report 5's concern 1 — "should the
two-kinds rule be structural" — is now **closed, structurally**). New:

1. **What the change costs, stated so a surface does not discover it.** A pinned sibling's *per-rung*
   own-fit diagnosis is gone: nothing can now answer "which sibling would block **Mid**" for a rung
   the turn is not pinned at. What survives answers the question §Story 1.3 actually asks — the
   pinned row's `availability` names the sibling that blocks the **selected** effort, and
   `turnDimensions` greys each rung with its reason. **The STOP-AND-ASK condition was evaluated and
   is not triggered**: no clause of `BILLING.md` asks a surface for a per-rung blocking sibling, and
   no consumer exists to want one. If a hover-level "why is Mid unavailable — because of *this*
   sibling" is ever wanted, the right carrier is a blocking-sibling field on the **turn-level**
   option (one reason per rung, one place), not a decision-shaped option list on a row nothing may
   decide from.
2. **`docs/BILLING.md` §Data Structures now understates the shape as well as mis-stating it** — line
   826's sentence is false and `ModelEntry` is no longer one record. Founder-owned; it is the doc
   batch's most reader-facing item, since a consumer reading the spec will write the read the
   compiler now rejects.
3. **`reasoning-plan.ts` still carries plan identifiers in comments** (`(G1)`, `(G3)`), forbidden by
   §Durable Naming. Pre-existing, outside my ownership, flagged not edited — unchanged from reports
   4 and 5.

## Confidence

**High.** The deliverable is a compile-time guarantee and it is proved as one, in both directions:
the old read is shown compiling before the change (`TS2578` on an unused expect-error) and shown
failing after it, using the deleted code verbatim. Behaviour is measured rather than argued — 15,288
turns with the hold, the manifest, the send gate, every refusal code, every row verdict, reason and
ceiling, `runnable` and the turn menu all at zero difference, on a differential controlled to fail
when it should. The retired pin's surviving claim was watched red under the exact regression it
guards, `turn-core.ts` restored byte-identically, both probe files deleted, and the whole shared
package is green at 2,970 tests with 100/100/100/100 on both changed production files.
