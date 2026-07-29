# D3 — impl report 2 — implemented

## Objective

The consumed set is derived **once**; the compiled artifact carries it; the storage estimator and
the interpreter both answer from that one derivation. No walk of the other representation survives.

## Files changed

| file | why |
| --- | --- |
| `packages/shared/src/workflow.ts` | `consumedProducerIds` becomes THE one derivation: edge-based over a whole definition, not a walk of node refs. Replaced in place, same export name, so the shared barrel is untouched. |
| `packages/shared/src/workflow.test.ts` | Its two tests re-expressed against definitions carrying edges; a third pins the branch case the old walk could not see. |
| `apps/api/src/slices/workflows/compile/compile-definition.ts` | `CompiledDefinition` gains `consumedProducers`, filled by that one derivation in `buildArtifact` — the single point where a definition becomes a compiled form. |
| `apps/api/src/slices/workflows/compile/compile-definition.test.ts` | Three pins on the new field: branch-only consumption, ordinary value edge, and the two non-consumptions (workflow input, container body feed). |
| `apps/api/src/slices/workflows/engine/interpreter.ts` | Its own `walkConsumedProducers` / `consumedProducers()` / memo field deleted; sinks and the streaming withhold read `this.compiled.consumedProducers`. |
| `apps/api/src/slices/workflows/engine/executor-construction.test.ts` | The same-value pin: one definition, the real estimator and a real run, over a branch-fed turn. Its `runSingleModelTurn` helper split into `singleModelTurn()` + `runTurn(definition, prompt)` so a second definition can be run. |
| `apps/api/src/slices/models/domain/estimate-run.ts` | Prices through the one derivation (`consumedProducerIds(definition)`) instead of the node-ref walk. Signature unchanged. |
| `apps/api/src/slices/models/domain/estimate-run.test.ts` | `workflow()` fixture builder takes `edges`; the storage pin re-expressed against an edge-complete definition, plus its discriminator and the branch and loop pins. |

**Not changed, deliberately:** `chat/domain/turn-definition.ts` (granted, but the estimator's signature
did not have to move — see Deviations), `workflows/engine/settlement.ts`, `smart-model-turn.ts`, any `.md`.

## Tests added

| test | behavior | criterion |
| --- | --- | --- |
| `compile-definition.test.ts` › names a producer whose only consumer is a branch | the artifact carries the set, and edge-only consumption is in it | one derivation site; no other walk |
| `compile-definition.test.ts` › names neither a workflow input nor a container feeding its own body | the two non-consumptions stay out | one derivation site |
| `compile-definition.test.ts` › names a producer read through an ordinary value edge | the ordinary case | one derivation site |
| `estimate-run.test.ts` › reserves NO output storage for a node whose output another node consumes | C3's property, re-expressed on an edge-complete definition | fixture rewrite (in scope) |
| `estimate-run.test.ts` › reserves that same output storage once nothing reads the node | the discriminator for the pin above: one edge moved, `BASE_1000` → `BASE_1000 + outputStorage` | the pin discriminates |
| `estimate-run.test.ts` › reserves no output storage for a producer only a branch reads | the exact-reserve improvement | ruled re-pricing |
| `estimate-run.test.ts` › reserves no output storage for a producer only a loop reads | same, through a loop's `in` port | ruled re-pricing |
| `executor-construction.test.ts` › holds no output storage for the value its own run does not persist | one definition, real estimator + real run: persisted set `{}` and the reserve strictly below the same graph without the branch | the storage reserve and the persisted set come from the same value |

## Self-gate

| command | result |
| --- | --- |
| `turbo typecheck --force --continue` (repo, uncached) | **pass — 16/16**, 0 cached |
| `pnpm arch:check` | **pass** — 13 rules over 2189 files |
| `eslint` on owned files, from `apps/api` | **pass (exit 0)** |
| `eslint` on owned files, from `packages/shared` | **pass (exit 0)** — re-run after the final edit |
| `vitest run src/slices/workflows src/slices/models` (apps/api) | **pass** — 1316 passed, 1 skipped |
| `vitest run src/workflow.test.ts` + full shared suite | **pass** — 3216 passed |
| `vitest run src/slices/chat` (apps/api) | **fail — 2 of 812**, attributed outward (below) |
| `eslint .` package-wide, `apps/api` and `packages/shared` | **fail**, attributed outward (below) |

### Scoped per-file coverage

One `--coverage.include` per run (the flag does not accumulate), reports directory outside
`apps/api/coverage`, include set driven by suites that actually exercise the file.

| file | stmts / branch / funcs / lines | driving suites |
| --- | --- | --- |
| `workflows/compile/compile-definition.ts` | 98.78 / 97.15 / 100 / 99.33 | `src/slices/workflows` + `src/slices/chat/domain` |
| `workflows/engine/interpreter.ts` | 98.33 / 95.96 / 97.56 / 99.45 | same |
| `models/domain/estimate-run.ts` | 100 / 98.92 / 100 / 100 | `src/slices/models` + `chat/domain` + `workflows` |
| `packages/shared/src/workflow.ts` | 100 / 100 / 100 / 100 (26/26, 11/11, 5/5, 23/23) | full shared suite |

All four ≥ 95 on every axis. The uncovered regions are pre-existing and untouched by this task:
`compile-definition.ts:592,776` (a loop-state tag arm and the `mustResolve` defensive throw),
`interpreter.ts:560-563` (the `subWorkflow` dispatch arm), `estimate-run.ts:83` (a media-bytes ternary).

### Failures attributed outward

- **`chat/routes.integration.test.ts` — 2 failures** in the slice sweep: `POST /chat` "returns a run
  handle (201)" got 400, and "replays the settled turn response (200)". This is §Known Breakage's
  documented moving set (`POST /chat 201→400` is named there verbatim). **Re-run alone: 199/199, exit 0.**
  Checked against the inverse rule before attributing: my diff adds no fixture that writes shared state —
  every fixture I added is an in-memory `WorkflowDefinition`, no catalog row, no counter, nothing behind
  a cross-suite lock.
- **`eslint .` package-wide**: `apps/api` exit 1 and `packages/shared` exit 1, entirely in files a
  concurrent agent is editing right now. Two consecutive `apps/api` runs returned **different** error
  sets (5 errors in `conversations/domain/history.ts` + `conversations/routes.integration.test.ts`,
  then 2 in `chat/domain/turn-context.test.ts` + `conversations/routes.integration.test.ts`) — a moving
  set, i.e. mid-flight edits, not a stable state. `packages/shared`'s three are prettier errors in
  `src/affordability/billing/funding-decision.test.ts`. mtimes confirm it: `conversations/domain/history.ts`
  14:21, `chat/routes.ts` 14:29, `chat/domain/turn-context.ts` 14:24, against my last edit at 14:12.
  None of the files are mine, and my own files lint exit 0 after my final edit in each package.
- **A later scoped `turbo typecheck --filter=@hushbox/api` went red** (14:31) on
  `chat/routes.ts` (`Cannot find name 'NonEmpty' / 'PriceableModel' / 'TurnMinCost'`) and
  `chat/domain/turn-context.integration.test.ts` (`minTurnCost` missing). Same cause: `chat/routes.ts`
  was written 5 seconds before that run. **The repo-wide typecheck with my complete change set was
  16/16 green at 14:09**, which is the gate result this task stands on.
- **Two `packages/shared` failures appeared and vanished mid-session** in
  `src/affordability/min-turn-cost.test.ts` (a full shared run at 14:12 was 3192/3192 green; a run at
  14:15 showed 2 failures over 3216 tests; a run at 14:17 was 3216/3216 green). `min-turn-cost.ts` and
  its test were written at 14:14:38 and 14:15:14 — inside the failing run's window. Passes in isolation.

## Acceptance criteria

**One derivation site — met.** `packages/shared/src/workflow.ts:consumedProducerIds` is the only
code in the repo that answers "which producers are consumed". Binary-inclusive sweep
(`grep -ran`, no piped second stage) over `apps packages scripts e2e docs`:

- `consumedProducer` → the definition (`workflow.ts`), its single storage site
  (`compile-definition.ts:667`), the two readers, the field declaration, and tests. Nothing else.
- `walkConsumed` → **zero hits** repo-wide (the interpreter's walk is gone).
- `'in' in ` → **zero hits** repo-wide (the old node-ref idiom is gone).
- `isSink` / `sinkOutputs` → one implementation, in `interpreter.ts`, reading the one set
  (`apps/api/src/lib/telemetry/request-telemetry.ts:isSinkName` is log sinks, unrelated).
- `.ins` / `over.node` → only compile's positional-port wiring and `isTurnClassifierNode`, which
  derives a different fact (classifier recognition), not consumption.

**Both consumers answer from that one derivation — met with a deviation on the mechanism.** The
interpreter reads the stored field (`interpreter.ts:613` for the streaming withhold, `:1059` for
sinks). The estimator calls the same derivation on the definition it prices, because it cannot import
the field's owner — see Deviations. There is no second implementation either way.

**No walk of the other representation survives — met.** Both walks that existed are gone: the
interpreter's compiled-graph walk was deleted, and the definition-side node-ref walk was *replaced*
rather than left standing beside the new one, so no dead second derivation remains.

**A pin that the storage reserve and the persisted set come from the same value — met.**
`executor-construction.test.ts` › "holds no output storage for the value its own run does not
persist": one definition is handed to the real production-wired executor and to the real
`createEstimateRun`. The run settles with `outputs: {}` (the branch reads the answer; a branch is
never a sink), and the reserve for that same definition is strictly below the reserve for the same
graph with the branch removed — i.e. the storage the reserve omits is exactly the storage the run
does not create. It is not a cross-check of two walks: there is only one, so nothing here could
"agree" or "disagree" — it pins the consequence.

**The ruled re-pricing, proven rather than argued — met, and measured.** Against the previous
node-ref walk (inlined temporarily to watch red), the two new pins failed with:

```
reserves no output storage for a producer only a branch reads
  AssertionError: expected 13700000n to be 12500000n
reserves no output storage for a producer only a loop reads
  AssertionError: expected 41100000n to be 39900000n
```

Both deltas are 1,200,000 nano-USD — one producer's worth of output storage
(1000 tokens × 4 chars/token × 300 nano/char), reserved against a value the run can never persist.
The direction is the amendment's: **over**-reserve, removed. `reserve ⊇ bill` still holds — the
loop pin's `bodyStorage` term shows the reserve still carrying storage for the one node that IS a
sink, so what was dropped is only the unbillable part.

**Reserved amounts unchanged on every production-buildable definition — met.**
`turn-definition.test.ts`, `smart-model-turn.test.ts`, `turn-ceiling.clamp-order.test.ts` and
`turn-ceiling.property.test.ts` are **157/157 green, unmodified**. Those files pin exact nano amounts
(`turn-ceiling.clamp-order.test.ts` computes `SERVER_HOLD` from the real estimator at module scope,
and the property test sweeps the fit) — so if a single production turn shape had re-priced, they
would have moved. The mechanism behind that is structural, not luck: production builds only
`modelCall` / `smartModel` / `fanIn` / `transform`, whose embedded refs `checkEmbeddedRefs` already
pins equal to their edges; only `branch`, `loop` and `subWorkflow` carry an input port with no
embedded ref, and no production path builds one.

**The C3 storage pin re-expressed, not deleted, and still discriminating — met.** It now runs on an
edge-complete definition (`input→m1`, `input→decide.in0`, `m1→decide.in1`) and still asserts
`BASE_1000`. Its discrimination is a named input, not an appeal to its existence: the sibling test
moves the single `m1.out → decide.in1` edge to `input.prompt`, changes nothing else, and the
assertion becomes `BASE_1000 + outputStorage`. That edge is the whole difference.

**Fixture compilability.** The three consumed-set fixtures in `compile-definition.test.ts` reach
`_unsafeUnwrap()` on `compileDefinition`, so they are compilable definitions by construction — that
is what the branch fixture proves, and the branch-fed turn in `executor-construction.test.ts` is
built by the production `buildWorkflow` and then actually run.

## Deviations, with reasons

1. **The estimator calls the one derivation instead of reading `CompiledDefinition.consumedProducers`.**
   The brief's shape — pass the set in — requires changing `EstimateRun`'s signature. Two things
   ruled that out:
   - **A slice cycle.** `models/domain` would have had to import the derivation's home. It lives in
     `workflows/compile`, and `workflows` already imports the `models` barrel at runtime in three
     places (`engine/live-execution-registry.ts`, `engine/model-resolver.ts`,
     `nodes/model-call-execution.ts`). The reverse edge is a barrel-level ESM cycle. Putting the
     derivation in `packages/shared` instead — which is what I did — is reachable from both slices
     with no new edge, and is where the walk being replaced already lived.
   - **Blast radius and a new failure mode.** A required second parameter ripples into ~22 call sites
     across five chat test files outside my ownership (`turn-ceiling.clamp-order`,
     `turn-ceiling.property`, `turn-definition`, `smart-model-turn`, `smart-model-turn.integration`),
     several with inline definition literals — while auditors are reading `chat/**`. Worse, it would
     *create* a way to be wrong that does not exist today: a caller could hand the estimator a set
     that does not match the definition it is pricing. As implemented, that is impossible.

   What the brief actually asked for is preserved: one derivation, no second walk, compile stamps it
   at the definition→compiled transition, and the engine persists by that stamp.

2. **`chat/domain/turn-definition.ts` was granted and not used.** The amendment granted it because
   changing the estimator's signature would break `fitAnswerCapToCeiling`. Since the signature did
   not change, that caller — and `smart-model-turn.ts`, which was *not* granted and holds two of its
   four call sites — needed no edit at all, and now prices through the same derivation admission uses.
   This is the cheaper resolution of the same problem the amendment identified.

3. **Two files outside the granted list were edited:** `packages/shared/src/workflow.ts` and
   `packages/shared/src/workflow.test.ts`. Not optional: the definition-side walk lived in that file
   and had to be *replaced* rather than left standing, or "no walk of the other representation
   survives" would fail and a dead export would remain. The export name is unchanged, so
   `packages/shared/src/index.ts` is untouched. I did **not** touch `workflow.ts:147`, the
   "(D3, dimension-composed)" comment the amendment queued for the close-phase batch.

4. **The branch/loop pins' red was watched by temporarily inlining the old node-ref walk in
   `estimate-run.ts`**, then deleting it in the same step that switched to the shared derivation. No
   background suite was in flight during that window. The `executor-construction.test.ts` same-value
   pin was written after the change and passed first run — its discriminating input (the branch edge)
   is the one measured red above, in `estimate-run.test.ts`.

## Concerns and limitations

- **`packages/shared/src/workflow.ts` has a queued close-phase edit** (the `:147` comment). My change
  is elsewhere in the file, but two agents editing one file in sequence is worth the orchestrator's
  attention.
- **The derivation's exclusion rule is `edge.from.port === producer.out`**, which relies on compile
  refusing a node whose declared `out` shadows its reserved virtual port. Both directions of that are
  already pinned (`compile-definition.test.ts`: "rejects a fanOut whose out port shadows its reserved
  'element' port" and the loop `'state'` sibling), so the claim in the function's doc comment is
  bounded by a gate rather than by prose.
- **The derivation is edge-based, so it is only meaningful for a definition that compiled.** Every
  path that reaches the estimator holds one: the interpreter compiles at `ingest()` before calling
  `estimateRun` in `run()`, and `fitAnswerCapToCeiling` / `trialLevelFits` are handed definitions
  `buildWorkflow` compiled. A hand-written non-compilable definition would now price every node as a
  sink — the over-reserving direction, and unreachable in production.
- **`workflows/engine/settlement.ts` and `settlement.test.ts` show as modified** in `git status`.
  They are not mine: mtimes 10:45 and 10:53, hours before this session.

## Confidence

**High.** The derivation is a four-line pure function whose two exclusions are pinned in both
directions; the over-reserve it removes was measured red before the change and green after; and the
claim that no production amount moved rests on 157 unmodified chat tests that pin exact nano
amounts, not on an argument about which node types production builds.
