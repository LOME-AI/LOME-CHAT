# B8 — impl report 3 — the five validated findings

Fix cycle over `impl-report-2.md`. Both auditors passed on substance; these are the five findings they
validated, plus the two corrections the orchestrator made against my own report and the process note
about `pnpm lint:unused`.

## Files changed

| file | finding | what changed |
| --- | --- | --- |
| `packages/shared/src/affordability/index.ts` | 1 | duplicate `export * from './tiers.js'` deleted; the seam comment now sits on the surviving line and makes no positional claim |
| `packages/shared/src/affordability/turn-options.ts` | 2, 4 | the docblock's claim about `BILLING.md` corrected; `requireUsableInstant` added and called first |
| `packages/shared/src/affordability/turn-types.ts` | 3 | `CatalogSnapshot` moved above `AnswerSources`' docblock, which documents `AnswerSources` again; `CatalogSnapshot`'s own block now names the validation |
| `packages/shared/src/affordability/turn-core.ts` | 3 | `boundReason`'s docblock moved back above `boundReason`; `tierAxisBlock` keeps its own |
| `packages/shared/src/affordability/turn-options.premium.test.ts` | 4 | 9 guard pins + 2 pins on what a wrong-but-usable clock can reach |
| `packages/shared/src/affordability/model-id.test.ts` | 5 | the compile-time brand pin |

## Finding 1 — one declaration of one fact, no positional claim

`export * from './tiers.js'` now appears once, at `:57`, carrying the seam comment:

```ts
export * from './pricing.js';
// Tier derivation and its constants — the tier half of the tier-and-premium
// classification seam (`docs/BILLING.md` §The public surface).
export * from './tiers.js';
```

The duplicate at the end of the file is gone, and with it the "premium is published below" claim —
`./premium.js` is published at `:73` and nothing followed the duplicate, so the sentence was false in
both halves. `grep -n "tiers.js" src/affordability/index.ts` → one line. The presence pin still passes
(`getUserTier`, `tierCanAccessPremium` are asserted at both entry points), which is what makes the
deletion safe rather than hopeful.

## Finding 2 — the corrected sentence

Before (mine, false): "§Where the Code Lives writes the call as `getTurnOptions(funding, basis,
selection)`".

After:

```
 * The fourth argument is a catalog SNAPSHOT rather than the catalog itself.
 * §The public surface already documents a fourth `catalog` argument and calls it
 * necessary rather than convenient — a `Selection` names models by identifier, and
 * §Smart Model requires the pool to be derivable from the catalog and the prompt
 * size, so the pool has to arrive from somewhere. What this signature adds to that
 * argument is the reference instant, because both legs of premium classification
 * are properties of the pool AS OF an instant: …
```

It now says what the doc says (four arguments, "necessary, not convenient") and what the code adds (the
instant), so the reader is not told the founder is being asked to amend something the doc never said.

## Finding 3 — the two displaced docblocks

`turn-types.ts`: `CatalogSnapshot` and its block now sit **before** `AnswerSources`' block, so

```
/** … the priceable catalog pool as of an instant … */
export interface CatalogSnapshot { … }

/** Where the turn's answers come from. At least one answer source is required … */
export type AnswerSources = …
```

`turn-core.ts`: `tierAxisBlock` keeps its own block; `boundReason`'s ("money first, then the prompt,
then the model's own output cap") is back directly above `boundReason` at `:401`. Both were the same
insertion mistake — a new block pasted at a `/**` boundary instead of after the declaration that block
belonged to. Verified by reading the final file, not the diff.

## Finding 4 — the instant is validated, and the asymmetry is closed

```ts
function requireUsableInstant(nowMs: number): void {
  if (!Number.isSafeInteger(nowMs) || nowMs < PREMIUM_RECENCY_MS) {
    throw new RangeError(
      'getTurnOptions: the catalog snapshot instant must be a safe integer no earlier than the premium recency window'
    );
  }
}
```

Called as `getTurnOptions`' first statement — the boundary the snapshot crosses. `RangeError` matches
this module's existing posture (`money.ts` and `exceedsTrialBudget` both throw `RangeError` with a
`function: reason` message).

**Watched red first, for the right reason.** All seven guard cases failed with "expected function to
throw an error, but it didn't" before the guard existed; the two clock-reach tests passed as controls.
After: 18/18 in that file.

| instant | before | after |
| --- | --- | --- |
| `Number.NaN` | premium row flipped to `{available: true}` | `RangeError` |
| `±Infinity` | permissive / closed | `RangeError` |
| fractional (`NOW_MS + 0.5`) | absorbed silently | `RangeError` |
| `0`, `-1` | failed closed by accident | `RangeError` |
| `PREMIUM_RECENCY_MS - 1` | absorbed; every model ever released is "recent" | `RangeError` |
| `PREMIUM_RECENCY_MS` (boundary) | — | accepted, so the guard refuses only the unusable |

**On the far-future half of the finding, and why the guard has no upper bound.** A far-future instant
is a *representable* instant whose recency leg is legitimately vacuous — and this module holds no clock
to check a caller's against, so any calendar ceiling would be a policy the money layer cannot justify
(and would reject a correct clock the day it passed). Instead the money-visible exposure is pinned
directly: the PRICE leg reads no clock, so a row that is premium by price stays refused however wrong
the clock is.

```
refuses a price-premium row on a correct clock          → { available: false, reason: 'premium_requires_credit' }
still refuses it a thousand years later                → { available: false, reason: 'premium_requires_credit' }
```

(`NOW_MS + 1000 × 365 days`, four-model pool so a price threshold exists, free tier.) So the residual
after this fix is narrow and stated: a **recency-only** premium row does become available under a
wrong-but-representable future clock, because that is what the instant means. Raised rather than
guarded.

## Finding 5 — the brand is pinned, the way this package already pins one

`model-id.test.ts`, following `nano-usd.test.ts:74-84` exactly:

```ts
it('rejects a plain string where a model identifier is expected', () => {
  const model: PriceableModel = {
    // @ts-expect-error — an unbranded string is not assignable to ModelId
    modelId: 'vendor/model',
    …
  };
  expect(model.modelId).toBe('vendor/model');
});
```

**Shown failing when the brand is removed** — the control the finding asked for. With
`ModelId` rewritten to `z.string().min(1)` + `type ModelId = string`:

```
src/affordability/model-id.test.ts(29,7): error TS2578: Unused '@ts-expect-error' directive.
```

and `tsgo --noEmit` fails. Restored: 0 errors. The pin sits on `PriceableModel` — a production shape —
rather than on a test-local helper, so it follows the type the wall's rule is about.

## The two corrections against my report

1. **My no-behaviour-change mechanism was wrong; the conclusion survives.** I claimed "only three
   affordability tests use a non-paid tier, and none of their fixtures classifies premium". False:
   `turn-options.property.test.ts:89` and `turn-options.agreement.test.ts:112` both declare
   `TIERS = ['paid','free','trial','guest']` and draw from it (`property:261,304,478,507`,
   `agreement:184`), so both sweep every tier across pools where rows do classify premium. My grep was
   for the literal `tier: 'free'` and could not see `pick(rng, TIERS)`.

   **The correct mechanism:** those two sweeps carry their own coverage controls, and a premium gate
   that collapsed rows would trip them rather than pass quietly — `property:277-283` requires >20
   sendable draws, >5 where the two sets differ, >20 smart-slot-beside-pinned, >5 candidate flips;
   `:490-492` requires >200 rows with >10 partial; `:522-523` requires a greyed row and >100 rows
   carrying rungs. Those are floors on *observed shapes*, so a change that greyed rows wholesale would
   fail the tallies, not the assertions. That is why the sweeps passing is evidence, and it is a
   different argument from the one I gave.

2. **Doc-correction 4's enumeration was incomplete.** Beyond the two storage constants,
   `turn-arithmetic.ts`'s `inputStorageNanoUsd` and `estimate/pre-adapters.ts`'s
   `outputStorageRatePerTokenNanoUsd` also compute storage money and are also walled — so the
   conclusion ("no storage-fee FUNCTION is on the surface") held for a broader reason than I gave.
   Recorded as amended in the batch; nothing to change in code. The fifth batch item I missed —
   `chooseFrom(options, rawAnswer)` documented with a bare `string`, against the module's own
   structural no-bare-`string` rule — is the founder's call and I have not touched it.

## The process note: `pnpm lint:unused`

Run this cycle. I was wrong to skip it, and wrong in the justification: the §Known Breakage entry I
cited is about a template snapshot test and says nothing about knip.

```
Unused files (1)
packages/config/vitest.package.config.ts
Configuration hints (1)
wrangler  apps/sandbox  knip.jsonc  Remove from ignoreDependencies
KNIP_EXIT=1
```

Red for one unmodified file outside my ownership and one config hint; **no unused exports at all**, so
my own hypothesis (that `resolveClassifierOutput` and `parseDimensionAnswer` would become unreachable
once `chooseFrom` composed them) did not materialise — both still have in-module callers. Nothing in
this task's diff appears in the output.

## Self-gate (all after the last edit)

| command | result |
| --- | --- |
| `pnpm test:shared` (coverage gate on) | **pass** — 132 files, **3181 tests**, no per-file threshold error |
| `npx vitest run src/affordability` in `packages/shared` | pass — 56 files, 1506 tests |
| `npx turbo typecheck --force --continue` (repo-wide, uncached) | **pass — 16/16** |
| `eslint .` in `packages/shared`, from the package dir | **exit 0** (run after the last edit in this package; no rule disabled anywhere in this cycle) |
| `apps/api` `src/slices/models` via `with-env` | pass — 42 files, 809 tests, 1 skipped |
| `apps/web` `src/hooks/billing` via `with-env` | pass — 237 tests |
| `pnpm lint:unused` | red on one unmodified file, attributed above |

This cycle's edits are confined to `packages/shared`; `apps/api` and `apps/web` were re-run anyway
because both consume the barrel this cycle reshaped.

## Acceptance criteria (deltas only)

| criterion | verdict |
| --- | --- |
| six exports + seams published, presence-pinned | still met; the duplicate export removed without changing what is published (presence pin green) |
| `ModelId` branded | **now enforced**, not merely asserted — TS2578 control shown |
| premium marking's data | still met, and the instant it grades against is now validated at the boundary |
| no wrapper only to satisfy a name | unchanged |
| no behaviour change beyond renames/import paths | unchanged, with the mechanism restated correctly above |

## Concerns and limitations

1. **The recency-only residual from Finding 4** (above): a representable future clock makes the recency
   leg vacuous, and no in-module check can distinguish a wrong caller clock from a correct one. The
   price leg is pinned clock-immune. If the founder wants that closed, it belongs to whoever serves
   `nowMs` (B9/E1/C3), as a served-value contract, not to the money layer.
2. **The lower bound is `PREMIUM_RECENCY_MS`, which couples the guard to premium's constant.** That is
   deliberate — it is the smallest instant at which "released within the window" is a meaningful test —
   but it means shortening the window loosens the guard. Both live in the same module and the boundary
   case is pinned, so a change to either reddens a test.
3. **Everything from report 2's concerns still stands**, unchanged by this cycle: the classifier prompt
   still renders the DECLARED effort domain (C3's criterion, needs a C2 file); C1's
   `CLASSIFIER_EFFORT_FALLBACK = 'medium'` still disagrees with §Reasoning Effort 8's cheapest-presented
   rule; `OptionSet` still cannot say whether the model axis was open; and the 22 `models/**` inventory
   rows still have no owning task, which blocks B8b.

## Confidence

**High** on findings 1, 2, 3 and 5 — each is a small, verified edit, and 5 carries an executed control
proving the pin bites. **High** on finding 4's guard (watched red, seven cases, boundary case pinned
accepted). **Medium** on finding 4's scope judgement: I closed the representable-nonsense half and
pinned the price leg's clock-immunity instead of inventing a calendar ceiling, and an auditor should
check that reading of "fails permissive" against the founder's intent.
