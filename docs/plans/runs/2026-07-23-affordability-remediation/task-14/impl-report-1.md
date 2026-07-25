# Task 14 — Classifier: one call, user-visible options, Min, everywhere — impl report 1

**STATUS: NEEDS_CONTEXT — stopped before any source edit.** No production or test
file was touched (`git status` is byte-identical to my start snapshot for every
file in the Task 14 Files list). The blocker is a design question that gates the
SHAPE of the whole task, not one criterion at its edge — resolving it after
implementing would mean throwing the implementation away.

## Objective (restated from plan §Task 14 + A12)

The classifier presents the turn's exact user-visible option set (union incl.
Min), runs as ONE call per turn composing model+effort, and runs on the paths it
currently skips — per A12 those are **multi-model**, **web-search**, and **trial**
`auto` turns, each of which must also get the typed classifier-unavailable error.

## The blocker: a multi-model `auto` turn cannot carry ONE classifier call

BILLING §Effort 6 is unconditional: *"One classifier call per turn. All decisions
ride one call on the cheapest priceable text model."* §Effort 4 then requires the
ONE classified effort to resolve **per model** across the turn's siblings.

Today the classifier exists only INSIDE the `smartModel` node execution
(`apps/api/src/slices/workflows/nodes/smart-model-execution.ts:108` —
`classifierCall` then `answerCall`, both within one node's `run`). There is no
definition-level classifier stage. That placement is what makes multi-model
unreachable, for three independently verified reasons:

1. **A `smartModel` node answers with exactly ONE model.** `runSmartModel` resolves
   one `modelId` and makes one `answerCall`
   (`smart-model-execution.ts:112-119`). A multi-model turn needs N answers.
2. **One node = one assistant message.** Settlement groups persistable charges by
   `charge.key` = the originating node
   (`apps/api/src/slices/chat/domain/settlement.ts:425-439`, doc at :421-423).
   Collapsing N siblings into one composite node would collapse N assistant
   messages into one — contradicting BILLING §Multi-Model 1/6.
3. **A sibling's effort cannot be fed from another node's output.** `modelCall`
   carries `params: z.record(z.string(), z.unknown())` — static JSON on the
   definition (`packages/shared/src/workflow.ts:43`). The only dynamic input is
   `in: PortRef` (:44), which is the prompt channel. The interpreter never reads
   or rewrites `params` (grep: zero `.params` references in
   `apps/api/src/slices/workflows/engine/interpreter.ts`). So a classifier node
   emitting "medium" has no wire into a sibling's reasoning params.

T13's own re-pinned assertion states the same conclusion from the other side
(`apps/api/src/slices/chat/routes.integration.test.ts:1470-1471`): *"The fan-out
has no classifier stage: if this turn ever became a smartModel composite, the
sibling generations would be dropped."*

**Therefore closing the multi-model path requires a NEW mechanism** — a
definition-level classifier stage whose result reaches sibling `modelCall` nodes
(a new node type, or dynamic params, or a run-level pre-stage in the executor).
That is an architecture decision (AGENT-RULES §Decisions: "New patterns deviating
from established ones" = *Cannot decide*), and every candidate mechanism lands in
files outside my ownership.

### Why this gates the OTHER two paths, rather than being deferrable alone

The web-search and trial paths ARE closable inside my Files list (see below) — but
only by extending the **`smartModel`-node** classifier. If the ruling is instead
"introduce a definition-level classifier stage", then that stage is the correct
home for web-search + trial + pinned-auto too, and the smartModel-node extension
I would have shipped becomes a second, wrong implementation of the same thing
(CODE-RULES §One Implementation, Shared). Implementing first and asking second
guarantees rework on a money-adjacent, 2-auditor task.

### Option set (decision material — I am not choosing)

- **A. Defer multi-model `auto` to T17.** T17 already owns building a composite
  definition with "one classifier call (model dimension; + effort dimension when
  auto)" over N siblings including a smart slot (plan §Task 17), and it owns
  `turn-definition.ts`. Multi-model `auto` stays reasoning-free until then (T13's
  interim, already pinned). T14 closes web-search + trial on the smartModel node.
  Cost: the reasoning-free window persists for pure multi-model (no smart slot)
  even after T17 unless T17's scope is widened.
- **B. Rule the mechanism now** (new classifier-stage node / dynamic params /
  executor pre-stage) and re-brief T14 with the enlarged file ownership,
  re-sequenced against T15/T17.
- **C. Accept multi-model `auto` as permanently deterministic-or-reasoning-free**
  and amend BILLING §Effort 6 accordingly. Requires a founder doc ruling; per
  Global Constraints I may not edit the doc.

## Second blocker (smaller): file ownership is short by two files

Even under option A, two required edits fall outside the Task 14 Files list. I am
flagging rather than taking them:

- `packages/shared/src/smart-model/prompts.ts` — the effort prompt text lives here
  (`EFFORT_SECTION` :71-73 hardcodes "low, medium, high"; `outputInstruction`
  :80-92 repeats it; `ClassifierPromptInput.classifyEffort` is a bare boolean
  :47-55). The criterion "the prompt lists EXACTLY the turn's `turnEffortOptions`
  labels" is unimplementable without changing this file's input shape.
- `apps/api/src/slices/workflows/engine/live-execution-registry.ts` — for the
  web-search criterion. `resolveModelCall` (:135-136) resolves `node.tools` into a
  tool loop; `resolveSmartModel` (:100-121) has no such wiring, and the
  `smartModel` node schema has no `tools` field at all
  (`packages/shared/src/workflow.ts:96-135`). "Answer sibling keeps `web_search`"
  therefore needs: a `tools` field on the node (workflow.ts — owned), the loop
  resolved for smartModel nodes (live-execution-registry.ts — NOT owned), the
  classifier call stripped of it (smart-model-execution.ts — owned; note
  `SmartModelExecutionDeps extends Omit<ModelCallStreamDeps, 'binding'>` at :64,
  so `deps.tools` would otherwise reach the CLASSIFIER call at :268), and
  `webSearchReservation` extended to smartModel nodes (estimate-run.ts — owned,
  currently modelCall-only at :434-437,457).

## Concurrency hazard the orchestrator should weigh

`apps/api/src/slices/chat/domain/turn-definition.ts` — the only home of
`buildMultiModelTurn` — is **T15's** Files list, and no `task-15/` directory exists
yet, i.e. T15 is un-dispatched and per the plan's dependency graph (`T13 →
T14/T15`) may run concurrently with T14. Any multi-model wiring that touches that
file must be sequenced, not parallelized.

## What I verified (all Verified — read this session, citations above)

- `smart-model-execution.ts` end-to-end (classifier + answer call composition,
  `pickClassifiedEffortPlan` application at :364).
- `packages/shared/src/smart-model/{effort-dimension,prompts,resolve}.ts` — the
  fixed `CLASSIFIER_EFFORT_LEVELS = ['low','medium','high']`
  (effort-dimension.ts:18) and the positional post-mapping (:83-105) the task must
  delete.
- `packages/shared/src/workflow.ts` (node schemas + `smartModelClassifierDimensions`
  :149-155 — the reserve⟺classify predicate the property test generalizes).
- `estimate-run.ts` classifier reserve + web-search reservation paths.
- `chat/routes.ts` gates: `body.models === undefined && … && !webSearchEnabled`
  (:748) for the paid path; the trial path never reaches a classifier
  (`trialTurnDefinitionOrRefusal` :840-891 → `trialReasoningOrRefusal` :787-802).
- T13's two re-pinned interim assertions
  (`routes.integration.test.ts:1429-1467` web search, `:1469-1510` multi-model).
- Run context: plan §Task 11/13/14/15/17, §Global Constraints, §Handoff,
  amendments A1/A3/A7/A8/A12/A12-CORRECTION/A14/A15, BILLING §Effort 1-8,
  §Smart Model, §Multi-Model, §Trial, both research files, T11 + T13 reports.

## Files changed

None. `git status` for every Task 14 Files-list path is unchanged from my start
snapshot; no test was added, no source edited.

## Self-gate

Not run — nothing was changed to gate.

## Acceptance criteria

All **not met** — implementation not started, pending the ruling above.

## Deviations

None (no work performed).

## Concerns and limitations

- The 1¢ trial-cap arithmetic (`MAX_TRIAL_MESSAGE_COST_CENTS`, BILLING §Trial vs
  the ~0.1¢ classifier reserve) is **not yet verified**. It is cheap to verify and
  I will do it in the same pass as the trial wiring once the shape is ruled; I did
  not want to report a number I had not computed.
- A14 is not implicated: nothing here requires touching `pickEffortClassifier` or
  `smart-model-affordability`'s cheapest-row-fail-closed selection.

## Confidence

High that the multi-model path is not implementable in this lane as briefed — the
three mechanisms are each verified by direct file read, and T13's own test comment
independently states the same conclusion. High that web-search and trial ARE
implementable on the smartModel node once ownership is extended by the two files
named above.
