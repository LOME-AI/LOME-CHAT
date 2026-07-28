# B8 — impl report 5 — Finding 7, and the vocabulary sweep

One finding: the file header of `turn-options.premium.test.ts`, falsified by my own additions. Fixed,
plus one further site the sweep found that the finding did not list.

## Files changed

| file | what changed |
| --- | --- |
| `packages/shared/src/affordability/turn-options.premium.test.ts` | the file header's two false claims; and one universal quantifier in the last block's comment, found by the sweep rather than named in the finding |

No production file changed. Comment-only, in one test file.

## The corrected header

```ts
/**
 * Premium classification reaching the produced sets.
 *
 * A premium row is MARKED, never removed: it rides `all` with an unavailable
 * verdict and a typed reason, so a surface greys it and says why (§Model
 * Classification, §Notices & Refusals 1). The clock is an ARGUMENT: every
 * instant here is injected, so a classification is reproducible from the
 * producer's inputs and the money core still reads no clock.
 *
 * The window and guard blocks use a single-model pool deliberately: the price leg
 * needs a pool of at least `MIN_POOL_FOR_PRICE_PERCENTILE` to have a threshold at
 * all, so one model isolates the RECENCY leg from it. The last block needs the
 * opposite and says so at its own fixture — a pool large enough to have a price
 * threshold, because what it pins is that the price leg reads no clock.
 */
```

Both false claims are gone and neither was replaced by a new count. "both cases below are driven from
one injected `nowMs`" became "every instant here is injected", which is what the file actually
guarantees and which no later test addition can falsify — the previous sentence was false the moment my
own guard block added a seventh instant. "The catalog here is deliberately one model" is now scoped to
the blocks where it is true, and the exception is stated as pointing at its own fixture rather than
restated (the four-model pool's reason lives at that fixture, `:151`).

## The vocabulary sweep — method, and what it found

Applied §Known Breakage's rule rather than re-reading my own hunks: for each mechanism my edits changed,
grep the module for that mechanism's vocabulary and check every hit against the current code. What
changed across this task, and the vocabulary each change put at risk:

| change | vocabulary grepped | hits | verdict |
| --- | --- | ---: | --- |
| `releasedAtMs` moved from `PremiumClassificationInput` onto `PriceableModel` | `release timestamp`, `releasedAt`, `its own argument`, `deliberately NOT here` | 3 prose hits | all three current: `priceable-model.ts:9-11` (the sentence corrected in cycle 1, now stating the release date IS here and why), `turn-types.ts:78` (the instant riding with the pool). `premium.ts` carries **no** prose about a release-date input — the field's own doc went with the field |
| `resolveFundingDecision` → `resolveFunding`, `noticeFor` → `notices` | both old names, code and prose, across `packages/shared`, `apps/api`, `apps/web` | 0 | clean |
| the producer's 5th argument folded into `CatalogSnapshot` | `fifth argument`, `five arguments`, `readonly PriceableModel[]` | 8 | zero stale: no "fifth argument" prose survives, and every array-typed hit is another signature that legitimately takes a pool (`turn-arithmetic.ts`, `premium.ts:56`, `turn-core.ts:109`) |
| `renderDimensionSection` now takes an option list; `parseDimensionAnswer` delegates to `dimensionOptionNamedBy` | all three names | 14 | all current, including the two `{@link parseDimensionAnswer}` references in `derive.ts:240,294` — both still describe what that function does after delegation |
| `ModelId` branded, ids no longer bare strings | `bare \`string\``, `bare string`, `branded` | 6 | current; the only claim about the brand being load-bearing is `model-id.ts:6-7`, and that claim is now the one carrying an executed TS2578 control |
| premium classification's pool-size precondition | `single-model`, `one model`, `pool of at least`, `MIN_POOL_FOR_PRICE_PERCENTILE` | 10 | one stale, in the header above; the other nine belong to other files' own fixtures and are accurate |

**The sweep found one site beyond the two the finding named**, in the same file and the same class:
`:149-151` claimed a price-premium row "stays refused **however wrong the clock is**" — a universal
quantifier over clocks resting on two measured draws. The structural fact is narrower and stronger, so
it now states the mechanism and where it lives:

```ts
  // … What matters for money is the other leg: `isPremiumModel`
  // takes no clock into its price comparison, so a row premium by price is refused
  // at whatever instant the guard admits. The two draws below are the correct
  // instant and one a thousand years out. …
```

That is checkable by reading `premium.ts:99-107` — the price comparison names no clock — instead of
being an extrapolation from two data points.

**Nothing else was found.** Outside those two sites the module's prose survives my edits intact, and I
am making that claim on the sweep above rather than on having re-read the diff.

## The observation the finding asked for

Finding 6 and Finding 7 are one failure mode seen twice, and the second instance is the diagnostic one:
the comment I fixed in cycle 4 was **inside the block I had added**, so re-reading my own hunks found
it. The header was **fourteen lines above** that block and was falsified by the same addition — and no
number of re-reads of a hunk can reach it, because the falsifying edit and the false sentence are not in
the same hunk. That is exactly what §Known Breakage's rule predicts, and my cycle-4 sweep was the
method the rule calls "not a sweep".

What makes the vocabulary method work is that it keys on the CHANGE rather than on the diff's geometry:
"I added instants" → grep the file for instant-counting words, wherever they sit. Applied above it took
minutes and found a third site. The cheap generalisation for the rest of this run: **after changing a
mechanism, grep for the words the old mechanism made true, not the lines you touched.**

## Self-gate (after the last edit)

| command | result |
| --- | --- |
| `npx vitest run src/affordability/turn-options.premium.test.ts` | pass — 14 tests |
| `pnpm test:shared` (coverage gate on) | **pass** — 132 files, 3181 tests, no per-file threshold error |
| `eslint .` in `packages/shared`, from the package dir, after the last edit | **exit 0** |

No repo typecheck and no `apps/*` runs this cycle: the only change is prose inside one test file, no
declaration moved, and the previous cycle's `turbo typecheck --force --continue` (16/16, uncached) stands
for every declaration. Stated rather than skipped silently.

## Acceptance criteria

No verdict changes. Finding 7 was prose falsified by my own additions; the guard, the pins and the
published surface are as reports 2–4 describe them.

## Concerns and limitations

1. **The recency-only residual stands** — a plausible-but-wrong future instant is recognisable only by
   the server that supplies `nowMs`, so closing it is a served-value contract for B9/E1/C3.
2. **Report 2's open items are unchanged and owned elsewhere**: the classifier prompt still renders the
   declared effort domain (C3, needs a C2 file); C1's `CLASSIFIER_EFFORT_FALLBACK = 'medium'` contradicts
   §Reasoning Effort 8's cheapest-presented rule; `OptionSet` cannot express whether the model axis was
   open; the five `BILLING.md` corrections await the founder.
3. **B8b must re-derive the walled-consumer inventory** rather than trust report 2's counts — C2 moved
   two rows while B8 ran.

## Confidence

**High.** Two comment edits, one of them found by a method whose output I have shown rather than
asserted, and the file's own tests plus the package coverage gate are green.
