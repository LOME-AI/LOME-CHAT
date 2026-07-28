# B6 — One effort resolver, and the spend bound it carries

## Objective

Collapse three effort-resolution implementations onto one; re-establish `B + H == ceiling`
as a boundary pin rather than a consequence of the deleted resolver; close the
classifier-reserve derivation defects (the truncator's ≤54-character envelope, the
description leg priced at zero, and the overhead priced against the wrong model list).

---

## Which implementation survived, and what the other two uniquely did

**Survivor: the registry resolver** — `resolveOption` in
`packages/shared/src/affordability/dimensions/derive.ts`, driven by the effort dimension's
declared `resolution: 'lowestOfferedWhenMandatory'` and its declared option domain
(`EFFORT_OPTION_IDS`, `off` at position 0). It is the only one that orders by the declared
domain rather than by enumeration accident, and the only one whose rule is data on the
registry entry rather than code in a walk.

The other two survive **as published names with unchanged signatures**, delegating to it.
That is not cosmetic: repointing their call sites would have required editing
`smart-model-execution.ts` (C2's), `turn-reasoning.ts` (C3's) and three `apps/web` files
(E1's). Neither denied file needed an edit — verified by grep after the change:

- `apps/api/src/slices/chat/domain/turn-reasoning.ts:140` still calls `resolveEffortForModel`
- `apps/api/src/slices/workflows/nodes/smart-model-execution.ts:371` still calls
  `pickClassifiedEffortPlan`

### #2 `resolveEffortForModel` (`estimate/effort-options.ts`) — unique behaviour: the wire-silence arm

Its own nearest-below walk is deleted. What it uniquely carried is the third arm of
`ResolvedEffort`: `{ kind: 'default' }` — send **no reasoning wire at all**. The registry
expresses "this model offers nothing on the axis" as `undefined`, which is also what it
returns for an unresolvable request, so a naive collapse loses the distinction the
consumers switch on.

Preserved by projecting the registry's return: `undefined → {kind:'default'}`,
`'off' → {kind:'off'}`, a rung → `{kind:'level', level}`.

**Evidence it still works.** `estimate/effort-options.test.ts` carries a bounded-exhaustive
property block with an **independent oracle** (`expectedResolution`) restating the ruled
semantics over 17 reasoning shapes × 6 choices, including the `default` arm
(`plainModel` → `{kind:'default'}` for every choice, lines 199–202) — it was green before
the collapse and is green after, unmodified. That is the strongest available evidence the
delegation is behaviour-identical, because the oracle is written against the specification
rather than against the implementation.

### #3 `pickClassifiedEffortPlan` (`smart-model/effort-dimension.ts`) — unique behaviour: the cap-feasibility step-down

Its distance sort is deleted (`grep` for `Math.abs(ladderPosition`, `distanceA`, `distanceB`
over `packages/shared/src/affordability/` returns nothing). What it uniquely carried is the
**step-down**: a rung whose reasoning budget leaves no whole answer token inside the
completion cap is skipped and the walk continues. Dropping it would let the plan fall
through to reasoning-free where today it runs a lower rung — a behaviour drop dressed as a
bug fix.

Preserved, and made **downward-only**: resolve through the registry, then walk the presented
support from the resolved option *downward* (`options.slice(0, index+1).toReversed()`),
taking the first whose budget leaves ≥ 1 answer token. The walk cannot turn upward, so a
step-down is always cheaper than what the classifier asked for.

**Evidence it still works.** `effort-dimension.test.ts` "steps down to a level whose budget
fits when the classified one exceeds the completion cap" (cap = the High budget exactly →
binds Medium, `maxTokens` = cap) — unchanged from before and green. Plus the new
"steps all the way down to the off rung when no rung fits the completion cap" and
"walks past a mandatory ladder's lowest rung to nothing when the cap cannot hold it".

### What changed behaviourally (deliberate, and the point of the task)

1. **Upward resolution is gone.** A model offering only High, asked for Low, used to bind
   High (distance 1). It now binds Min when reasoning is disableable, or `undefined` when
   the ladder is mandatory and the cap cannot hold its lowest rung. The old test asserting
   the upward bind is rewritten; §Reasoning Effort 4 forbids it.
2. **`pickClassifiedEffortPlan` returns an explicit off plan where it used to return
   `undefined`.** When the model can disable reasoning and no rung fits the cap, the walk
   reaches the off rung and returns `{wire:{enabled:false}, maxTokens: cap}` instead of no
   wire. `maxTokens == cap` either way, so the spend bound is untouched; and it makes the
   two adapters agree (`resolveEffortForModel` already returned `{kind:'off'}` for exactly
   this shape). `undefined` now means precisely: the model offers nothing on the axis, or a
   mandatory ladder's lowest rung does not fit.

---

## The `B + H == ceiling` boundary pin

`packages/shared/src/affordability/smart-model/effort-dimension.test.ts`,
`describe('the spend bound: B + H equals the held ceiling')`.

**Subject:** the plan's `maxTokens` equals **the cap argument it was handed**, and
`reasoningBudgetTokens + answerHeadroomTokens` equals that same cap — never a number
re-derived from a budget, a ladder tier or a model bound.

**Sweep:** every reasoning shape the descriptor schema admits (undefined · `{}` ·
`{mandatory}` · `supportedEfforts: null` ± mandatory · native vocabularies of length 0–6 ±
mandatory) × three cap contexts (roomy 200k context; `maxOutputTokens: 3000`;
`contextLength: 900`, which clamps every rung to the protocol floor) × **every option the
registry presents** (`EFFORT_OPTION_IDS` — off, lite, low, medium, high, max) × a cap sweep
that is deliberately boundary-shaped: `2`, `3`, the protocol floor and floor+1, and
`budget − 1 / budget / budget + 1` for each of the five ladder tiers, plus max+10 000 and
`Number.MAX_SAFE_INTEGER`. The boundary caps are where an off-by-one re-derivation shows and
a comfortable cap does not.

**Vacuity guard:** the sweep counts the arms that returned a plan and asserts > 1000, so an
over-strict change that made every arm return `undefined` cannot satisfy the assertions
trivially.

**What the pin would catch:** any future edit that *computes* the cap instead of passing it
through — clamping to a model bound inside the plan, returning `B + fixed H`, or rounding the
answer headroom. Each silently over-spends the hold by the difference; no other assertion in
this suite ranges over the cap argument, so nothing else would go red. The subject is the
**argument**, not a recomputed expectation, which is what stops the pin drifting with the
implementation it guards.

A second property in the same block pins the direction of the collapse itself: on every
non-mandatory shape, the option actually bound (read back off the returned wire) is never
above the classified option.

### The fourth `B + H` site — reported, not pinned

`nodeAnswerCap` at `apps/api/src/slices/chat/domain/turn-definition.ts:332` solves the same
equation in the other direction: `cap = answerTokens + nodeReasoningBudgetTokens(node, …)`,
then `Math.min(requested, modelAnswerRoom(...))`.

**Out of scope, and this is a criterion I could not fully satisfy inside my bounds.**
`turn-definition.ts` and `turn-definition.test.ts` are on no Files list here (the file is B4
/ lane C territory), so I neither edited nor added a test there. Two facts I did verify by
reading:

- it derives B through the shared `reasoningBudgetForWire(reasoningPlanModelFrom(descriptor),
  wire)` — the same function my sweep exercises through `pickClassifiedEffortPlan` — so the
  B half is shared, not duplicated;
- it is the **stamping** direction (H given, cap produced) and it then clamps by physical
  room, so `cap == B + H` is not unconditionally true there by design (§Multi-Model 3: a
  tight-context sibling clamps its own cap). A property test asserting equality there would
  be wrong; the right statement is `cap ≤ B + H`, and it needs an owner with that file.

Raised for the orchestrator to sequence.

---

## The classifier reserve, and the three derivation defects closed

### (a) The truncator's envelope — priced quantity now measured against the thing priced

Measured red first: `truncateForClassifier` on a 10 000/10 000 input emitted **4054**
characters against a reserve priced for 4000. The arithmetic is exactly the section
envelope — four labels (`[USER START]` 12, `[USER END]` 10, `[AI START]` 10, `[AI END]` 8) each
followed by `': '` (+2 each ⇒ 48) plus three `'\n\n'` separators (+6) = **54**.

**Fix (emitter side, no mirrored constant):** `fillCaptureBuffers` now starts from
`MAX_CLASSIFIER_CONTEXT_CHARS − envelopeChars(directions)`. `envelopeChars` is derived from
the same `dir.label` values and the same `SECTION_LABEL_SUFFIX` / `SECTION_SEPARATOR`
constants that `formatSections` emits — one label list, one place. A `+ 54` constant is
refused; nothing anywhere states the figure.

It counts both directions of every non-empty source, which over-estimates by one
label+separator when a short source lets START swallow the whole message. That direction is
deliberate and stated in the comment: the amount priced must never be smaller than the amount
emitted.

**Pin:** `classifier-context.test.ts` "never emits more than MAX_CLASSIFIER_CONTEXT_CHARS in
total, labels included" over five saturating shapes, plus "spends the whole budget when there
is content for every section" (`out.length === MAX_CLASSIFIER_CONTEXT_CHARS` exactly). The
two pre-existing tests that asserted the *stripped content* hit 4000 now assert the *emitted
message* hits 4000 — the same claim, moved onto the quantity the budget actually bounds, and
needing no envelope figure to express.

The other half of the bound is pinned in `classifier-line-item.test.ts` ("bounds a real
render of the same pool, whatever its descriptions say"), so neither side can move alone.

**Doc check, as the criterion requires:** the shipped cap is 4000 and §Reasoning Effort 6 says
4,000. They agree; no founder finding. The gap was the emitter exceeding the cap, not the
figure.

### (b) The description leg priced at zero

`turn-core.ts` passed `{id}` only, and `smart-model-affordability.ts` passed
`description ?? ''` — both priced the per-model description leg at **0 characters** while the
executor renders the real description (up to `CLASSIFIER_MAX_DESCRIPTION_CHARS` = 100, since
`truncateDescription` clamps it there).

`computeClassifierPromptOverhead` now takes `readonly { readonly id: string }[]` — **no
description at all** — and renders each model's line with a 100-character filler. The
arithmetic: `truncateDescription` returns the description unchanged at ≤ 100 chars and
`slice(0, 99) + '…'` (also exactly 100 chars) above it, so a 100-character filler is the exact
worst case and the priced line is ≥ the emitted line for **every** description, character for
character.

This also removes free text from a money-layer signature, which §Where the Code Lives wants
anyway.

**Pin:** `prompts.test.ts` "bounds a render carrying ANY real description, at the declared
maximum" (empty · short · cap−1 · cap · 50×cap) and "is independent of the descriptions,
because it does not take them" (overhead equals a real render at exactly the cap).

**No `PriceableModel` field was needed** — the contract change flagged as possibly required is
closed rather than opened.

### (c) The overhead priced against the full catalog

`turn-core.ts` priced the overhead against the **whole catalog** while the executor's prompt
lists only what it will actually name. `classifierReserveNanoUsd` now takes two lists and the
comment states why they differ:

- **engine** — still the cheapest model over the whole priceable catalog. It must stay
  prompt-independent, or the two option sets could pick different engines and break
  `admissible ⊆ affordable`.
- **prompted** — `plan.smartSlot ? plan.classifierPool : []`.

**Why this is an upper bound by construction, not by measurement.** `computeClassifierPromptOverhead`
is monotone non-decreasing in the list it is given, and the executor's list is a subset of the
prompted list in every case:
`smart-model-execution.ts:classifierRequest` supplies `eligibleModels: node.candidates` only
when `dimensions.model`, and `smartModelClassifierDimensions` sets that false unless
`candidates.length > 1`; `node.candidates` is the affordability-narrowed classifier pool, so
`candidates ⊆ classifierPool`. When the model dimension is not open the executor names **no**
models, which is what `[]` prices. The previous shape compared two *different* lists with
descriptions priced at zero on one side — so the error had **no fixed sign**, and an
unsigned error is not a bound however large it happens to be. That property, not the
magnitude, is what changed.

**Pins:** `turn-core.test.ts` "prices no model list on a turn whose only open dimension is
effort" (40 extra catalog models leave the reserve bit-identical — red before the fix at
892 400n vs 650 900n) and "prices the classifier-selectable pool, not the catalog, when a slot
is open" (the same 40 models grow the reserve, because the prompt genuinely gets longer).

### (d) Classifier-storage strip — already done by B5, verified in code, not from its report

`estimate/classifier-line-item.ts` emits a single `classifier-tokens` provider item and no
storage item at all; `turn-core.ts`'s `kind === 'provider'` filter is already gone as dead.
B6's conditional item is therefore a no-op. Verified by reading the files, per BOUNDS (no
sibling report was read).

---

## A defect the vocabulary change exposed, and closed

Moving effort onto the **label** vocabulary made `parseDimensionAnswer` match `Min`, `Lite`,
`Low`, `Mid`, `High`, `Max` through `resolveClassifierOutput`, whose third arm is a
**bidirectional substring** match. That is sound for long distinctive model ids and unsound
for three-letter words: `'turbo-max-overdrive'` matched `Max` and bound a real 65 536-token
reasoning budget off an answer that named nothing. It surfaced as a live api test failure
(`smart-model-execution.test.ts` "falls back to medium on an unresolvable effort output"
returned `{effort:'high'}`).

`parseDimensionAnswer` now picks its matching rule from the **declared domain**, not from the
call site: a fixed literal domain (short words) must be **named** — case-insensitive equality
after stripping surrounding quotes/backticks/sentence punctuation; a catalog domain
(identifiers) keeps the fuzzy matcher. Failing to match yields the declared fallback, the
cheapest presented option, so the failure direction is the cheap one.

Pinned both ways in `derive.test.ts`: "does not bind a label that merely appears inside an
unrelated answer" (four prose shapes) and "matches a catalog-domain dimension with the fuzzy
identifier matcher".

---

## Files changed

### `packages/shared`

| Path | Why |
| ---- | --- |
| `affordability/dimensions/derive.ts` | `answerTextFor` split so `dimensionAnswerText` can report "no line for this dimension"; `parseDimensionAnswer` matching rule now follows the declared domain (the short-label soundness fix) |
| `affordability/dimensions/effort.ts` | support/requirement exposed over `ReasoningPlanModel` (`effortSupportOf`, `effortRequirementOf`) so both adapters share one support; `effortDomainOptions` for the classifier prompt's option line |
| `affordability/estimate/effort-options.ts` | `resolveEffortForModel` is now a projection of the registry resolver; its own nearest-below walk and its duplicate `canDisableReasoning` predicate deleted |
| `affordability/smart-model/effort-dimension.ts` | distance sort deleted; `pickClassifiedEffortPlan` = registry resolution + downward-only step-down; `CLASSIFIER_EFFORT_LEVELS` deleted, `ClassifierEffortLevel` = `EffortChoice`; `parseClassifierAnswer` reads labelled lines |
| `affordability/smart-model/prompts.ts` | effort section and answer-line instruction generated from the registry entry; `computeClassifierPromptOverhead` prices descriptions at the declared cap and takes none |
| `affordability/smart-model/index.ts` | drops the deleted `CLASSIFIER_EFFORT_LEVELS` export |
| `affordability/estimate/classifier-line-item.ts` | `classifierReserveChars` takes the **prompted** list, ids only |
| `affordability/estimate/smart-model-affordability.ts` | stops passing `description ?? ''` (one line) |
| `affordability/turn-core.ts` | reserve priced against the prompted pool; engine still catalog-wide |
| `mock-directives.ts` | `classifierEffort` enum sourced from `EFFORT_OPTION_IDS` (the deleted triple's last consumer) |

Tests: `dimensions/derive.test.ts`, `dimensions/effort.test.ts`,
`smart-model/effort-dimension.test.ts`, `smart-model/prompts.test.ts`,
`estimate/classifier-line-item.test.ts`, `turn-core.test.ts`,
`turn-options.property.test.ts`.

### `apps/api`

| Path | Why |
| ---- | --- |
| `slices/workflows/nodes/classifier-context.ts` | section envelope counted inside the priced budget, derived from the emitter's own label list |
| `slices/models/adapters/mock-provider.ts` | emits one labelled line per dimension, effort as the user-facing label |

Tests: `classifier-context.test.ts`, `mock-provider.test.ts`, plus three
**expectation-only** updates outside the Files list (see Deviations):
`smart-model-execution.test.ts`, `resolve-model-provider.test.ts`, `chat/domain/runtime.test.ts`.

---

## Tests added

| Test | Behaviour | Criterion |
| ---- | --------- | --------- |
| `effort-dimension.test.ts` › "never rises to a rung above the classified level…" | downward-only resolution lands on Min, not the nearer rung above | one resolver, downward-only |
| › "takes the nearest rung BELOW…" | the N=2 ladder case, restated against the downward rule | one resolver |
| › "rises to a mandatory model's lowest rung" | the one upward exception | mandatory carve-out |
| › "walks past a mandatory ladder's lowest rung to nothing…" | `undefined` when nothing below fits | wire-silence arm |
| › "steps all the way down to the off rung…" | the cap-feasibility step-down, made downward-only | step-down survives |
| › "returns the cap it was handed, for every shape, option and cap" | `B + H == ceiling`, boundary sweep + vacuity guard | the spend bound |
| › "never binds a rung above the classified option unless mandatory" | direction of the collapse | one resolver |
| › `parseClassifierAnswer` labelled-line block (5 tests) | labels carry the pairing, not line order | classifier options from the registry |
| › `resolveClassifiedEffort` label block | Min / Lite / Max resolvable; the triple is gone | registry labels incl. Min, Lite, Max |
| `dimensions/effort.test.ts` › "is total over every reasoning shape…" | `e_min(m)` total, corner reachable | `e_min(m)` total |
| › "names a real rung… on the live mandatory-single-rung shape" | the shape that used to have no corner | `e_min(m)` total |
| `dimensions/derive.test.ts` › "is not bought on a real catalog shape whose whole ladder plateaus" | distinctness on the **resolved requirement**, no hand-filtered support | plateau ⇒ no classifier call |
| › "does not bind a label that merely appears inside an unrelated answer" | short-label soundness | (defect found here) |
| › "tolerates formatting noise around a label the answer does name" | quotes/backticks/punctuation | (same) |
| › "matches a catalog-domain dimension with the fuzzy identifier matcher" | the rule follows the declaration | (same) |
| `turn-options.property.test.ts` › "never leaves a gap, on either set, across 200 generated turns" | feasible set is a downward-closed prefix | prefix property |
| `prompts.test.ts` › registry-label / labelled-line block (4 tests) | the prompt presents the registry's labels and names each dimension's line | classifier options from the registry |
| `prompts.test.ts` › "bounds a render carrying ANY real description…" + "is independent of the descriptions…" | overhead is an upper bound by construction | reserve upper bound |
| `classifier-line-item.test.ts` › "bounds a real render of the same pool…" | reserve ≥ template + excerpt | reserve pinned against what is emitted |
| `turn-core.test.ts` › "prices no model list on an effort-only turn" / "prices the classifier-selectable pool, not the catalog" | prompted list, not the catalog | presentable-pool overhead |
| `classifier-context.test.ts` › "never emits more than MAX_CLASSIFIER_CONTEXT_CHARS…" + "spends the whole budget…" | the emitted message respects the priced cap | ≤54-character gap closed |

### Two pins that passed on first run — and how I gave them teeth

Both correspond to criteria that are **regression pins of behaviour a sibling task or an
earlier cycle already made correct**, not new production code, so TDD's red step could not
come from my own change. I verified each by mutating production code, watching red, and
restoring:

- **`e_min(m)` totality.** Re-introducing the pre-B5 early return
  (`if (natives.length === 1 && reasoning.mandatory === true) return []` in
  `offeredLevels`) reddens both new tests ("expected undefined to be defined", "expected
  undefined to be 'high'"). `reasoning-plan.ts` verified byte-identical to HEAD afterwards
  (`git diff HEAD -- …reasoning-plan.ts` empty).
- **Downward-closed prefix.** Forcing the `off` rung unavailable in `turn-core.ts`'s
  `dimensionsFor` reddens the property test. `turn-core.ts` restored to my own version
  afterwards (verified by reading the full diff vs HEAD).

---

## Self-gate

All gates below were run **after my last edit anywhere in the repo**, in this order.

| Command | Exit | Result |
| ------- | ---- | ------ |
| `npx turbo typecheck --force --continue` | `TYPECHECK_EXIT=0` | **pass — 16/16, 0 cached.** The §Known Breakage `packages/config` untracked-rule entry (15/16) did **not** reproduce — reported, not chased. |
| `pnpm test:shared` | `SHARED_TEST_EXIT=0` | **pass** — 127 test files; the per-file coverage gate runs inside `test` and is therefore green |
| `pnpm test:api` | `API_TEST_EXIT=1` | 1 failed \| 467 passed \| 1 skipped (469 files); 7 failed \| 6421 passed \| 3 skipped (6431 tests) — see below |
| scoped api coverage, `--coverage.include` over my two `apps/api` production files | — | `classifier-context.ts` 100/100/100/100; `mock-provider.ts` 100 stmt / 97.81 branch / 100 func / 100 line (gate is 95) |

### Lint — the set derived from `git status`, one run per package, from the package directory

`git status --porcelain` after my final edit lists changed files in
`apps/api`, `packages/shared`, `apps/web`, `packages/config`, `packages/db`, `packages/ui`,
`apps/admin`, `apps/marketing`, `scripts`, `e2e`, `docs`, `.github` and the repo root.
**Two of those carry my changes** — `apps/api` and `packages/shared` — and every other entry
belongs to the concurrent workstream. I linted my two, whole-package (which is what CI does),
capturing the status on the command itself rather than through a pipeline:

| From | Command | Captured |
| ---- | ------- | -------- |
| `packages/shared/` | `npx eslint . > out 2>&1; echo "SHARED_EXIT=$?"` | `SHARED_EXIT=0` |
| `apps/api/` | `npx eslint . > out 2>&1; echo "API_LINT_EXIT=$?"` | `API_LINT_EXIT=0` |

The api run went **red first** (one `prettier/prettier` error in
`classifier-context.test.ts:84`), which is exactly the failure mode Constraint 9 describes; it
was fixed and the package re-linted from its own directory afterwards. That fix — a
whitespace-only reflow inside a test file — is my last edit, and the `pnpm test:api` figures
above come from the run that followed it.

### `pnpm test:api` — the failures, attributed

All seven are in `slices/notifications/domain/templates/template-html.test.ts` — the
§Known Breakage entry belonging to the concurrent push/notifications workstream (snapshot
failures over a removed Google-Fonts `<link>`; the template source and its `.snap` are
unmodified relative to HEAD and untouched by me). Not mine, not fixed. **Reproduced
identically across four consecutive full runs** (same seven tests, same 467/1/1 file split),
which is what a deterministic foreign failure looks like — the load-dependent entries in
§Known Breakage do not behave that way.

An earlier run additionally showed two `chat/routes.integration.test.ts` trial failures (403 vs 201).
Attribution, checked rather than assumed:

- both pass in isolation under `scripts/with-env.ts` (2 passed / 186 skipped), and the whole
  file passes;
- they did **not** reproduce in run 2;
- my diff adds no fixture and writes to no shared state — the two new `turn-core` tests are
  in-memory pure-function tests;
- the trial route's 403 path does not reach any file I changed: `chat/routes.ts` imports
  nothing classifier/effort/prompt-related, and the live classifier reserve exists only on
  `smartModel` nodes (`estimate-run.ts:509`), while the failing tests send a single explicit
  model.

That matches the §Known Breakage shared-catalog-percentile 403 class exactly. I applied the
inverse-attribution check that entry demands and it clears.

---

## Deviations, with reasons

1. **Files-list path correction.** The list names `apps/api/src/mocks/mock-provider.ts`; no
   such file exists. The intended file — the hardcoded triple's mock consumer — is
   `apps/api/src/slices/models/adapters/mock-provider.ts`, and that is what I edited.
2. **Ownership extended to three api test files, expectation-only.** The mock now answers
   `model: <id>` / `effort: <Label>` instead of positional lines, which broke asserted
   strings in `resolve-model-provider.test.ts` (1), `chat/domain/runtime.test.ts` (1) and
   `smart-model-execution.test.ts` (1 fixture). No production code in those files changed;
   the alternative was leaving the repo red. Same shape as B5's ruled test-file extension.
3. **The classifier is presented the effort dimension's FULL declared domain, not the turn's
   presented subset.** `buildClassifierSystemPrompt`'s input shape is unchanged
   (`classifyEffort?: boolean`), because narrowing it to a per-turn option list needs
   `smart-model-execution.ts` and `classifier-messages.ts`, neither of which is mine. This
   satisfies the criterion as written ("options come from the registry entry with the
   user-facing labels including Min, Lite and Max") but not §Reasoning Effort 6's "exactly the
   options the user saw". It cannot produce an infeasible plan — the resolver is total and
   downward-only and the step-down guarantees cap feasibility — so the residual is accuracy,
   not correctness. **C2 should close it when it repoints.**
4. **`parseDimensionAnswer`'s matching rule changed** (see the defect section). This is
   beyond the literal criteria but was forced: the vocabulary change made the old rule
   unsound, and it produced a wrong reasoning budget in an existing api test.
5. **Stale comments corrected in files I was already editing**, per "a wrong comment is worse
   than none": `turn-core.test.ts` ×2 (the reserve is no longer "a function of the catalog"),
   `effort-options.test.ts` ×1 (`mandatoryOneLevel` "offers nothing" predates B5's ladder
   fix), `prompts.ts` ×2 (`classifyEffort` no longer means "low | medium | high"; the excerpt
   cap now bounds the emitted message).

---

## Concerns and limitations

1. **The classifier prompt text changed, so CI cassettes will miss.**
   `apps/api/src/slices/workflows/engine/smart-model.integration.test.ts` makes a real
   OpenRouter classifier call in CI under record-on-miss cassettes keyed by a hash of the
   canonical request. The new prompt hashes differently, so the next CI run makes one real
   charged classifier call and records it. That is the designed behaviour of the mechanism,
   not a break, and it self-heals — but it is a founder-visible cost and `AI_RECORDING_VERSION`
   needs no bump (the key shape is unchanged, only the request content).
2. **The fourth `B + H` site is unpinned** (see above). It is the one criterion I could not
   satisfy inside my bounds.
3. **The residual I was told not to fix, restated so nobody "fixes" it later:** on turns whose
   only open dimension is effort, pinning drops the classifier reserve, so the menu is
   conservative by ≈0.1¢. Pre-existing, safe direction, and closing it needs a second pricing
   pass per rung — the multiple-derivation hazard B3 spent three cycles removing. Left alone.
4. **The reserve moved in both directions.** Descriptions priced at the declared cap raise it
   (by ~100 chars × prompted models); the prompted-pool basis lowers it (by the catalog minus
   the pool, and to zero models on an effort-only turn). Net effect per turn is not a single
   sign, and the money-relevant claim is only that it is now an upper bound by construction.
   Both live folds (`smart-model-affordability.ts` → `estimate-run.ts`, and
   `trial-smart-model-candidates.ts`) inherit the description change; the trial 1¢ cap is the
   place a rise could bite, and no trial test regressed (see the attribution above), but this
   is the item I would most want a second auditor to price independently.
5. **A both-dimensions answer with no labelled line now yields both fallbacks** (cheapest
   candidate + the caller's medium default) where the old positional parser guessed from line
   order. Deliberate — guessing from position is how a positional protocol returns — but it is
   a real behaviour change on a malformed-answer path.

---

## Confidence

**Medium-high.** High on the resolver collapse: an independent pre-existing oracle over the
whole model space was green before and after without modification, and the two behaviours the
plan warned about are each separately pinned. High on the truncator envelope: measured red at
exactly the predicted 4054, fixed with no mirrored constant, bounded on both sides by tests in
the two packages.

Medium on the reserve re-basing, for the reason in concern 4: the change is provably an upper
bound, but it is not a monotone move in magnitude, it touches the live admission path through
two folds I do not own, and money-flagged work deserves an independent recomputation rather
than my own. Medium too on the protocol swap, which is correct against every test I can run
but whose real-model behaviour is only observable through a cassette that has not been
re-recorded.
