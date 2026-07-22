# T7 — Generalized classifier stage: effort dimension — impl report 1

## Objective

Per plan §Task-T7 + §T7-addendum: dimension-compose the classifier stage so one
classifier generation per turn can classify model and/or effort; canonical
low|medium|high scale; unresolvable ⇒ medium with the charge standing;
non-reasoning model + auto ⇒ no call/charge/reserve; admission classifier-reserve
condition extended to `SmartModel ∨ effort=auto`; charge stays the one
`auxiliaryCharges` classifier entry; relax T5's 400 seam for SmartModel+auto;
inherit closing smart-model-execution.ts's branch-coverage gap.

## Design shape (implementer-decided within the plan)

- **Pinned+auto is a single-candidate `smartModel` node** declaring
  `classify: { model: false, effort: true }` — the model dimension
  short-circuits (the plan's "pinned via single-candidate short-circuit"), the
  effort dimension drives the one classifier generation. This is the only way
  a classifier generation can exist for a pinned turn (nodes are the only
  execution unit), and it makes the admission reserve structural.
- **`classify` dimensions field** added to the smartModel node schema
  (`packages/shared/src/workflow.ts`), strict-object, absent = legacy
  `{ model: true, effort: false }`. `smartModelClassifierDimensions()` (same
  file) is the ONE authority for "which dimensions actually classify" —
  imported by BOTH admission's reserve condition (`estimate-run.ts`) and the
  node execution, so reserve ⟺ generation can never drift (One Implementation,
  Shared).
- **Reserve-preserving runtime carve-out**: the classified level's plan is
  carved OUT of the node's already-built completion cap
  (`pickClassifiedEffortPlan` returns `maxTokens === cap` always), so a
  runtime pick can never spend past the admission hold (reserve ≥ charge by
  construction). The pinned+auto build sizes that cap at the HIGHEST
  affordable level's B + H (classifier reserve deducted first, then
  `reconcileAnswerCeiling` re-fits through the one canonical estimator).
- **Positional mapping** (per §Interface-notes exact-membership ruling): the
  classified canonical level maps onto the model's `offeredLevels` ladder by
  position distance, ties to the LOWER (cheaper) rung, stepping to the nearest
  offered level whose budget fits the cap; nothing offered/fitting ⇒
  reasoning-free answer. Never plan-level substitution — the plan stays
  exact-membership.
- **Badging**: `smartModelRan` now equals the DECLARED model dimension
  (`node.classify?.model ?? true`) — a pinned+auto turn is not badged Smart
  Model (the user picked the model); every pre-existing shape is unchanged,
  including the single-eligible Smart Model short-circuit (still badged).
- **Classifier model for pinned+auto** = cheapest priceable engine-text model
  (`pickEffortClassifier`, the Smart Model derivation reused).
- **Prompt/output protocol**: dimension markers `[MODEL]`/`[EFFORT]` ride the
  marker line (mock-detection contract, same as the base marker); both-dims
  output is two lines (model id, then effort word), parsed per-dimension via
  `parseClassifierAnswer` + `resolveClassifierOutput` against closed sets.
- **T6 addendum honored**: classifier resolution reads
  `parseReasoningText(value).answer`, pinned by a reasoning-streaming
  classifier fixture.
- **G2 shape**: the effort wire is only applied when the node params carry a
  numeric `maxOutputTokens`; a capless node runs reasoning-free (test-pinned).

## Files changed

packages/shared:
- `src/smart-model/prompts.ts` — dimension-composed prompt (optional
  eligibleModels + classifyEffort), `[MODEL]`/`[EFFORT]` markers, model list
  stays last; `computeClassifierPromptOverhead` renders BOTH dimensions
  (upper bound for every composition — reserve stays sound).
- `src/smart-model/effort-dimension.ts` (new) — `CLASSIFIER_EFFORT_LEVELS`,
  `resolveClassifiedEffort`, `parseClassifierAnswer`,
  `pickClassifiedEffortPlan` (positional, cap-preserving).
- `src/smart-model/index.ts`, `src/index.ts` — barrel exports (incl.
  `smartModelClassifierDimensions`).
- `src/workflow.ts` — smartModel `classify` field +
  `smartModelClassifierDimensions()` (single dims authority).
- `src/mock-directives.ts` — `classifierEffort` knob (low|medium|high).

apps/api:
- `slices/workflows/builder/smart-model.ts` — `classify` passthrough.
- `slices/workflows/nodes/smart-model-execution.ts` — dimension-composed
  classifier call (prompt, per-dimension resolution via `.answer`, medium
  fallback on unresolvable AND on classifier error), effort applied to the
  answer params via the shared carve-out, badge = declared model dimension;
  refactored into `classifierRequest`/`resolveClassifierValue`/
  `mediumFallback`/`classifiedAnswerExtras` (lint complexity).
- `slices/models/domain/estimate-run.ts` — classifier reserve held iff
  `smartModelClassifierDimensions(node)` has an active dimension (the
  `SmartModel ∨ effort=auto` condition line).
- `slices/models/domain/smart-model-candidates.ts` — `pickEffortClassifier`
  (+ barrel exports in domain/index.ts, models/index.ts).
- `slices/models/adapters/mock-provider.ts` — dimension-aware classifier
  answer (model line iff model dim, effort line iff effort dim; effort =
  `x-mock-classifier-effort` directive ?? 'medium').
- `slices/chat/domain/smart-model-turn.ts` — `classify` on
  `SmartModelTurnParams`; `classifyEffort` threading on paid + trial Smart
  Model builders gated by `effortDimensionForCandidates` (≥1 reasoning-capable
  candidate, else no dimension/charge/reserve); NEW `compileAutoEffortTurn` /
  `buildAutoEffortTurnDefinition` (pinned+auto build with `fallback` result);
  `compileSmartModelBuild` signature → options object (lint max-params).
- `slices/chat/domain/index.ts` — barrel exports.
- `slices/chat/domain/turn-reasoning.ts` — comment only: the placeholder
  order's remaining owners (multi-model, web-search, trial, fallback).
- `slices/chat/routes.ts` — seam relax: SMART_MODEL_ID + `auto` allowed
  (explicit levels still 400) on paid AND trial routes; pinned+auto routed to
  `buildAutoEffortTurnDefinition` with fallback to the regular path
  (web-search turns excluded — composite node carries no tool loop);
  extracted `smartModelDefinitionOrRefusal`/`trialSmartModelDefinitionOrRefusal`/
  `pinnedAutoDefinitionOrNull`/`mediaDefinitionOrRefusal` helpers (complexity).

## Tests added (name — behavior — criterion)

- shared `prompts.test.ts` (+4, 2 updated): dimension markers per composition;
  effort-only prompt (no model list); both-dims two-line instruction; base
  marker stays the prefix (mock contract); overhead = both-dims render and is
  an upper bound on single-dim renders.
- shared `effort-dimension.test.ts` (new, 21): canonical scale; fuzzy effort
  resolution (exact/case/prose/unresolvable/empty); per-dimension answer
  parsing (incl. blank-line and one-line degradation); positional pick
  (verbatim, budget-native wire, N=1 → high, tie → lower, step-down under
  cap, non-reasoning ⇒ undefined, no-fit ⇒ undefined, maxTokens === cap
  invariant). Tie-break rule mutation-checked.
- shared `workflow.test.ts` (+6): classify parse/strict-reject;
  `smartModelClassifierDimensions` default/short-circuit/pinned+auto/both.
- api `build-workflow.test.ts` (+1): builder classify passthrough.
- api `smart-model-execution.test.ts` (+10): pinned+auto one effort-only
  generation + wire + unchanged cap + charge + NOT badged; reasoning-streaming
  classifier fixture (`.answer` parse — addendum pin); both-dims one call +
  badge; unresolvable ⇒ medium + charge stands; classifier ERROR ⇒ medium, no
  charge; non-reasoning resolved candidate ⇒ params untouched; capless node ⇒
  reasoning-free (G2); step-down under cap; model-only single-candidate
  short-circuit (no call); answer value keeps streamed reasoning serialized.
- api `estimate-run.test.ts` (+2, 6 fixtures updated): single-candidate
  model-only ⇒ NO reserve; single-candidate effort-dim ⇒ reserve; existing
  reserve-scaling/guard/pricing tests updated to declare the effort dimension
  (their subjects preserved).
- api `smart-model-candidates.test.ts` (+3): `pickEffortClassifier` cheapest
  pick + reserve basis over pinned candidate; no text model ⇒ null; rateless ⇒
  null.
- api `smart-model-turn.test.ts` (+12): classify onto node; pinned+auto build
  shape (single candidate, classify, B_high+H cap, storage stamp, hooks);
  admission-fits check; fallbacks (non-reasoning/unknown/rateless/no
  headroom/no-context-length/single-level-mandatory empty ladder);
  description carry; `effortDimensionForCandidates` gate both ways.
- api `smart-model-turn.integration.test.ts` (+1): trial builder with
  `classifyEffort` over a reasoning-capable trial candidate (budget-less
  path) declares both dimensions on the node.
- api `mock-provider.test.ts` (+4): directive parse; effort-only answer;
  two-line both-dims answer; directed effort knob.
- api `routes.integration.test.ts` (1 replaced, +3): SmartModel+auto 201 with
  classify {model:true,effort:true}; explicit level on SmartModel still 400;
  pinned+auto builds the single-candidate effort node with cap > B_high;
  pinned+auto on non-reasoning model stays a plain modelCall (no reserve
  path).

## Self-gate

- `pnpm test:shared` — pass (100 files, 2217 tests, per-file coverage gate
  green).
- `pnpm test:api` — PASS (full run, exit 0, 8m28s, per-file coverage
  thresholds met; zero "does not meet" errors). An earlier full run failed
  ONLY on `smart-model-turn.ts` branch coverage (90.54% < 95, my new code);
  fixed by adding 3 unit tests (capless-model fallback, description carry,
  single-level-mandatory empty-ladder fallback) and 1 integration test
  (trial builder classifyEffort + budget-less arms), then re-ran green.
- `pnpm typecheck` (shared, api, realtime, from package dirs, tsgo) — pass.
- `pnpm lint` (shared `eslint .`, api `eslint .`, run AFTER the final edits
  from the package dirs) — pass.
- `pnpm arch:check` — pass (11 rules / 1861 files).
- Coverage inheritance: `smart-model-execution.ts` now 100% statements /
  100% branches / 100% functions / 100% lines (was 94.73% branches under the
  foreign diff) — verified via scoped json-summary run AND passing the full
  per-file gate. (`model-call-execution.ts` 98.67% branches, lines 632-633 —
  T5-owned error-mapping file, above the 95 gate, untouched by me.)
- ps-check for live vitest before the final api gate: none running.

## Acceptance criteria

- Dimension-composed classifier stage, prompt composed from requested
  dimensions — MET (prompts.ts + execution; test-pinned).
- Output parsed per-dimension via `resolveClassifierOutput` against closed
  sets — MET (`resolveClassifiedEffort` delegates to the same matcher;
  model dimension unchanged).
- Canonical low|medium|high for effort — MET (`CLASSIFIER_EFFORT_LEVELS`).
- Exactly one classifier generation per turn in every combination — MET for
  pinned+auto (single-candidate short-circuit of the model dimension),
  SmartModel alone (unchanged), SmartModel+auto (both dimensions in the one
  call); test-pinned at execution and route level. See Deviations for
  multi-model+auto.
- Unresolvable effort ⇒ medium, charge stands — MET (test-pinned; also on
  classifier ERROR the effort falls back to medium with NO charge —
  documented choice consistent with the model dimension's error fallback).
- Non-reasoning model + auto ⇒ no call, no charge, no reserve — MET
  (pinned: route fallback to the regular turn, T5's placeholder no-ops;
  SmartModel: effort dimension only declared when ≥1 candidate is
  reasoning-capable; reserve keyed on the same dims authority).
- Admission classifier-reserve condition extended to `SmartModel ∨
  effort=auto` — MET via `smartModelClassifierDimensions` in
  `estimateSmartModelNode` (reserve iff an active dimension).
- Charge remains one `auxiliaryCharges` classifier entry in the same
  settlement — MET (mechanism untouched; keySuffix `classifier`).
- Relax T5's 400 for SmartModel+auto — MET (paid + trial seams; explicit
  levels still refused, media unchanged, `none` no-op unchanged).
- Addendum: classifier parses `.answer` via shared parser — MET, pinned with
  the required reasoning-streaming classifier fixture.
- Addendum: `TurnReasoningEntry.effort` includes 'none' — handled: no T7 code
  path can receive an off entry (`compileAutoEffortTurn` runs only for the
  `auto` selection, its level probe iterates high/medium/low only; the
  runtime carve-out never yields an off wire). No switch over the field
  exists in T7 code to miss the variant.
- Inherit the smart-model-execution.ts coverage gap — MET (100% branches).

## Deviations, with reasons

1. **Multi-model + auto keeps T5's placeholder resolution** (no classifier).
   The turn is N sibling `modelCall` nodes; a classifier generation can only
   live in a node, and restructuring the fan-out into a composite is outside
   T7's files. The plan's combination list (pinned+auto / SmartModel alone /
   SmartModel+auto) does not name multi-model. Raised.
2. **Pinned+auto + webSearch keeps the placeholder** — the smartModel node
   carries no tool loop; wiring tools into it is an engine change. Raised.
3. **Trial pinned+auto keeps T5's deterministic resolution** (no classifier)
   — `trialReasoningSelection` maps auto to a fitting level before the build;
   a classifier charge has no place in the 1¢ no-charge trial pinned path.
   Trial SMART+auto does classify (the trial Smart turn already runs a
   classifier). Documented choice.
4. **Single-candidate model-only Smart Model nodes no longer hold the
   classifier reserve** (they never bill one — the short-circuit makes no
   generation). Strictly reserve-reducing; aligns reserve ⟺ charge. Raised
   for the auditors as a behavior change to existing Smart Model admission.
5. **SmartModel+auto answer cap is NOT raised by a B term** — the classified
   level carves its budget out of the existing worst-candidate cap (thinking
   spends inside the cap). Reserve-sound by construction; the pinned+auto
   path, by contrast, adds B_high on top before reconciliation. Product
   tradeoff documented in code.

## Concerns and limitations

- The classifier's own generation still runs WITHOUT a reasoning config; a
  default-enabled reasoning classifier model thinks inside
  `CLASSIFIER_OUTPUT_TOKEN_CAP` (pre-existing behavior, unchanged).
- `parseClassifierAnswer` takes the DESIGNATED line per dimension in
  both-dims mode; a model that answers on one line loses the effort word and
  falls back to medium (deterministic, test-pinned).
- Ownership stretch: `packages/shared/src/workflow.ts`,
  `src/mock-directives.ts`, and `mock-provider.ts` were edited additively —
  necessary carriers of the node contract and mock determinism; all edits are
  additive and lint/typecheck/test clean. `estimate-run.test.ts` fixture
  updates preserve their original subjects.
- TDD note: the shared `effort-dimension` module and the route-seam pins were
  not individually watched RED before implementation (the module's first run
  was post-implementation; route pins were written after the seam edit). The
  tie-break test was mutation-verified; the estimate-run, execution, prompts,
  workflow, builder, and mock cycles all had observed REDs.

## Confidence

high — every acceptance criterion is test-pinned at the layer it lives
(shared unit, execution unit, admission unit, route integration), the money
invariant (reserve ≥ charge) holds by construction (runtime cap never
exceeds the built cap), and all scoped gates are green.
