# C3 — impl report 7 — the false docblock, and one disposition restored

## Objective

Close the last audit Minor: `MultiModelTurnDefinitionOptions.catalog`'s docblock, which described
a behaviour the code does not have.

## The finding, confirmed

The comment said an absent `catalog` "leaves an `auto` turn unclassified, which is the shape every
non-route caller wants". It does not. `compileMultiModelTurn` passes `options.catalog ?? []` to
`turnClassifierFor`, so a classifiable `auto` turn reaches `pickEffortClassifier([]) === null` and
returns `err(CLASSIFIER_UNAVAILABLE)` — **a hard refusal**.

I confirmed the auditor's other half too: `turn-ceiling.property.test.ts` sweeps
`EFFORTS = [undefined, 'low']` and never `'auto'`, so no test entered the path from either side.
No production caller omits the snapshot. That is why it survived five cycles and a sweep — nothing
could have gone red, and the sentence was the only description of the behaviour.

## What I chose, and why

**I restated what absence does; I did not make the sentence true.** The coordinator was right that
a future caller may want the graceful-degradation shape the comment promised — so this is the
reasoning rather than a preference:

Making omission mean "do not classify" turns a **forgotten argument into a silent product
regression**. A caller that wired everything else correctly and simply failed to pass the snapshot
would ship `auto` turns that classify nothing — which is precisely the regression C3 was opened to
remove, and it produces no error, no log, and no failing test. The reserve would still be held and
never spent, exactly as the interim state did.

Refusing is the fail-closed direction and is already the ruled behaviour for the condition it is
indistinguishable from: an empty catalog and a catalog holding no priceable text model are the same
observation, and §Reasoning Effort 5(d) rules that one a typed error with explicit levels still
usable. So the code was right and only the sentence was wrong.

The docblock now says: **absent is an empty catalog, not an opt-out**; a classifiable `auto` turn is
refused with the typed code; a pinned-effort turn or one with fewer than two rungs never asks and is
unaffected; and a caller that genuinely wants an unclassified turn **says so by not selecting
`auto`** — a statement about the turn, not about an argument it left out.

## The sentence is now checkable rather than promised

The finding's real cause was that neither behaviour was pinned, so prose was the only authority.
Both arms now have one:

- a classifiable `auto` turn with no catalog → `CLASSIFIER_UNAVAILABLE`;
- a pinned-effort turn with no catalog → builds, with no classifier prompt.

**Proven to discriminate against the exact shape the false comment described:** I made
`turnClassifierFor` return "no classifier" when the engine is null — the graceful-degrade reading —
and the first pin failed. Restored byte-exact (`diff` verified). So if a future task decides the
degradation shape is wanted after all, it cannot land it silently; it has to change a test that
states why the refusal exists.

## The disposition that went missing

Report 3 listed the **fourth `B + H` site pin** as not delivered; reports 4 and 5 named it neither
closed nor open, which is how it vanished. Stating it plainly: **it is closed, and it was closed
before I touched it.**

`turn-definition.test.ts:1146` ("fits the definition within the payer funds while preserving B and
the wire") drives `reconcileAnswerCeiling → withAnswerCap → nodeAnswerCap` — the fourth site — and
asserts `cap − B ≥ 1` and `cap − B ≤ guess`, i.e. the **inequality** `cap ≤ B + H` that B6
established as the true statement, not the equality. It also asserts the wire survives the fit
unchanged. My `isAnswerNode` change this run altered which nodes that sweep touches, and the pin
still holds, which is the useful fact: the property survived the change that could have broken it.

No code was needed; this was a reporting gap, and the auditor was right to raise no finding.

## Calibration accepted

Report 4 said the four fallback pins "each discriminate against the old rung". Two do so literally
(`not.toBe('medium')` in `turn-decision.test.ts` and `effort-dimension.test.ts`); two do so
structurally — the registered-reducer pin and the slot pin fail under the old constant for their
own reasons, but neither names it. "Slightly generous" is fair, and the two literal ones are the
load-bearing pair.

## Self-gate

| Command | Result |
| --- | --- |
| `pnpm test:api` | **7 failures, all the documented template-html family**, nothing else |
| `turbo typecheck --force` (api + shared) | **2/2** |
| `eslint` from `apps/api`, both changed files | **exit 0**, empty output |
| `turn-classifier.test.ts` | 19 passed |

One inversion this cycle, with a byte-exact restore verified by `diff`, and no background suite in
flight during it.

## Confidence

**High.** The behaviour was read out of the code rather than from the comment, the choice between
the two fixes is argued from which failure mode is silent, and the new pin was shown to fail under
the alternative reading rather than merely to pass under this one.
