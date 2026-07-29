# D3 — impl report 1 — NEEDS_CONTEXT (no code written)

## Objective

Collapse the two consumed-set walks into one derivation read by two consumers: the storage
estimator (`models/domain/estimate-run.ts`) and the interpreter
(`workflows/engine/interpreter.ts`). Per §D3: the derivation sits at the single point where a
definition becomes a compiled form, and both consumers read that field.

**No production code and no tests were written.** Two of the task's own stop-and-report triggers
fire, and the blocker is structural: the task cannot be completed inside its declared ownership.

## Status of the tree

`git status --porcelain` at start: 119 entries, none of them mine (readme hash caches,
`scripts/.cache`, and a concurrent workstream's files). I made no edits, so the tree is
byte-identical to how I found it.

## Finding 1 — there is a THIRD reader of the consumed set, and it is out of bounds (BLOCKER)

The plan's design context names two consumers. There are three. The third is
`fitAnswerCapToCeiling` in `apps/api/src/slices/chat/domain/turn-definition.ts:449-476`, which
the brief names as **C5's territory**.

- `turn-definition.ts:455` constructs its own estimator instance: `const estimate =
  createEstimateRun(resolveModel);`
- `turn-definition.ts:457` prices a bare definition inside a binary search: `const priced =
  estimate(withAnswerCap(definition, cap, resolveModel));`
- Its input is storage-stamped — `reconcileAnswerCeiling` (`turn-definition.ts:493-502`) passes
  `stamped` straight through — so the consumed set **changes the number this caller computes**.
  (`smart-model-turn.ts:423` is the second call site of the same function.)
- It holds **no compiled form**. `buildSingleModelTurn` compiles via `buildWorkflow` and then
  discards the artifact — `turn-definition.ts:644`: `.map((compiled) => compiled.definition)`.

Consequence: `EstimateRun`'s signature is
`(definition: WorkflowDefinition) => Result<NanoUSD, DomainError>`
(`estimate-run.ts:48`). Making the estimator *read a field on the compiled graph* requires
changing that signature, which breaks `fitAnswerCapToCeiling` — a file I must not touch.

And this caller cannot simply be left behind. Its entire contract is that it prices through
**the ONE estimator admission uses** (`turn-definition.ts:391-407`, "the authoritative cap is
therefore whatever the ONE estimator admission uses accepts"). If admission's estimator moves onto
the compiled consumed set and the fit stays on the definition walk, I would be *creating* a new
disagreement between the fit and admission — the fit could hand back a definition admission then
refuses. That is a worse instance of exactly the class D3 exists to remove.

## Finding 2 — the derivation site the plan names is not in my ownership

"The single point where a definition becomes a compiled form" is
`apps/api/src/slices/workflows/compile/compile-definition.ts` — `buildArtifact` at line 637, which
constructs `CompiledDefinition` (declared at line 43). Both compile entry points go through it:
`interpreter.ts:382` (`ingest`) and `builder/build-workflow.ts:37`.

My ownership is `workflows/engine/**` (minus `settlement.ts`) plus `estimate-run.ts`. `compile/`
is a sibling directory of `engine/`, and the plan's own Files list for D3
(`workflows/engine/**`, `models/domain/estimate-run.ts`, tests) does not include it. Placing the
derivation anywhere inside `engine/**` instead would put it *after* the definition→compiled
transition and would still not reach the chat build path, so it does not rescue the task.

## Finding 3 — the design context's "they differ only on container ids" is incomplete

Stated in §D3: "They cannot disagree today — they differ only on container ids, which are never
priced." Three verified reads say there is a second divergence class. I did **not** execute a
probe, so this is deduction from reads, not a measured result:

1. `packages/shared/src/workflow.ts:234-242` — `consumedProducerIds` adds an id only from
   `'in' in node`, `fanIn.ins`, and `fanOut.over`.
2. `packages/shared/src/workflow.ts:105-120` — the `branch` and `loop` node schemas carry **no
   `in` field** (`branch` = predicate/cases/else; `loop` = body/until/maxIterations).
3. `compile-definition.ts:417-430` — `consumerPorts` gives `branch` and `loop`
   `[SINGLE_INPUT_PORT_ID]`, and `checkInputCompleteness` (406-414) reports `missing_input` when
   that port is unfed. `compile/conventions.ts:12` documents the port as belonging to
   "modelCall/transform/**branch/loop**/smartModel". `checkEmbeddedRefs` (382-392) declares **no**
   embedded ref for `branch`/`loop`/`subWorkflow`.

So a `branch`, `loop` or `subWorkflow` node consumes a producer **through an edge only**. The
compiled walk (`interpreter.ts:1081-1094`) sees it; `consumedProducerIds` cannot.

Direction, which matters: the definition walk misses the consumption ⇒ the estimator treats the
producer as a sink ⇒ it **over**-reserves storage, while the interpreter treats it as consumed and
does not persist it. `reserve ⊇ bill` still holds. It is not a live under-reservation.

Dormancy: no production code constructs a `branch` or `loop` node — `grep -a` for `branch(`/`loop(`
across `slices/chat`, `slices/admin` and `slices/workflows/definitions` (excluding tests) returns
nothing; the only construction sites are the builders themselves
(`workflows/builder/{branch,loop}.ts`). Real turn definitions use `modelCall`, `smartModel` and
`fanIn` only.

I therefore did **not** treat stop-trigger 1 ("a live under-reservation … a money defect with its
own reproduction") as met — the premise, an under-reservation, is false. It is recorded here as a
correction to the design context and as extra justification for the collapse.

## Finding 4 — the estimator cannot move onto the compiled representation without rewriting its fixtures

Every definition in `estimate-run.test.ts` is built by the local `workflow()` helper, which sets
**`edges: []`** (`estimate-run.test.ts:149-161`). Those definitions express consumption purely
through node refs (`in` / `ins` / `over`) and would fail `compileDefinition`'s
`checkInputCompleteness` outright.

The pin this breaks is C3's, at `estimate-run.test.ts:1190` ("reserves NO output storage for a node
whose output another node consumes"): its `fanIn` names `m1` in `ins` but declares no edge, so
under any edge-based derivation the consumed set is empty and the expectation flips from
`BASE_1000` to `BASE_1000 + outputStorage`. Sibling storage cases at 1211, 1221 and 1269 sit on
the same helper.

This is fixture debt, not a blocker on its own — the fixtures should carry edges — but it sizes the
real task well beyond "two readers, one field", and it is the reason the collapse cannot be a
mechanical two-file change.

## Finding 5 — stop-trigger 3 (reserved amounts) needs a ruling, not a judgment call

"If removing either walk changes any reserved amount, stop."

- On every definition production builds today (`modelCall` / `smartModel` / `fanIn`, no containers,
  edges matching the embedded refs, which `checkEmbeddedRefs` enforces), the two walks agree, so
  the collapse moves **no** amount.
- On a definition with a `branch`/`loop` consumer (Finding 3), collapsing onto the compiled walk
  **lowers** the reserve — from over-reserved to exactly what settlement bills. No production path
  builds one, and no estimator test builds one with a storage stamp.

That is a real, if unreachable, re-pricing. It is the correct number, but it is a decision the
plan has not made, so I am surfacing it rather than absorbing it.

## What I did not do, and why

I did not write the failing test first, because the shapes available to me all fail before TDD
starts:

- **Field on `CompiledDefinition`, estimator reads it** (the plan's literal shape) — requires
  `compile-definition.ts` (not owned) *and* `chat/domain/turn-definition.ts` (C5's, explicitly
  out of bounds). Blocked.
- **Estimator compiles internally** — `models/domain` would import the `workflows` barrel for
  `compileDefinition`, needs a `CompileContext` the estimator factory has no access to, and
  compiles ~10× per binary search. This is stop-trigger 2 verbatim: a consumer reaching across a
  slice boundary it should not.
- **One shared derivation function over `definition.edges`, stamped at compile, called by the
  estimator** — signature unchanged, so the chat build path keeps working. This is the only shape
  I can see that is nearly in bounds, and it still needs `compile-definition.ts` and
  `packages/shared/src/workflow.ts`, plus the fixture rewrite in Finding 4. It also satisfies
  "one implementation, shared" but is a weaker form of "both consumers read that field".

Deciding between these is a plan decision about scope and ownership, not an implementation detail
I may pick silently.

## Adjacent observation, not mine to fix

`packages/shared/src/workflow.ts:147` carries a shipped comment reading
"The classifier dimensions this node requests (D3, dimension-composed)" — a plan identifier in
committed code (Global Constraint 8). The plan already tracks a sibling instance at
`affordability/smart-model/prompts.ts:42` (plan.md:4796); this one is in the same class and may not
be on that list.

## Self-gate

None run. No file was edited, so there is nothing to lint, typecheck or test. Running the `apps/api`
suite is barred for me by the brief (G8 owns it).

## Confidence

**High** that the task is blocked as scoped — Findings 1 and 2 rest on direct reads of the call
sites and the ownership list, and neither depends on execution.
**Medium** on Finding 3's exact reach: the deduction from three reads is sound but unexecuted, and
I did not probe whether some other consumer shape also escapes `consumedProducerIds`.
