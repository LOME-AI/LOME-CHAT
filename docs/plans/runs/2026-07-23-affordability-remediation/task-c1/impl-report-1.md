# C1 — The decision envelope — implementation report 1

## Objective

A runtime decision reaches N consumers through the existing single input port, with no new
node type and no relaxed compile invariant: the classifier becomes an ordinary `modelCall`
whose answer reaches its consumers through a registered reducer, and streams nothing into
the user's conversation.

## Files changed

| Path | Why |
| --- | --- |
| `apps/api/src/slices/workflows/nodes/turn-decision.ts` (new) | The `TurnDecision` schema, the pure `decideTurn` reducer body, the declared effort fallback, and the two input-shape readers (`decisionOf`, `callInputOf`). |
| `apps/api/src/slices/workflows/nodes/turn-decision.test.ts` (new) | Unit pins for the reducer's parse / ladder clamp / declared fallback and the schema's closed effort domain. |
| `apps/api/src/slices/workflows/engine/workflow-capabilities.ts` | Registers the envelope schema as the FIRST entry in the capability schema registry and the `decideTurn` reducer `[text, optional<text>] → json<turnDecision>`. |
| `packages/shared/src/workflow.ts` | The one additive persisted field: `inputSchema` on `modelCall` and `smartModel`. |
| `apps/api/src/slices/workflows/engine/model-ports.ts` | `portsAccepting` — the single derivation swapping a node's input port for the schema it declares; read by both the compiler and the runtime. |
| `apps/api/src/slices/workflows/engine/node-registry.ts` | Honours `inputSchema` for `modelCall` and for the Smart Model slot's compile-time ports. |
| `apps/api/src/slices/workflows/nodes/smart-model-execution.ts` | Honours `inputSchema` at the slot's second (runtime) port declaration, reads its prompt through `callInputOf`, and takes the shared effort fallback constant. |
| `apps/api/src/slices/workflows/nodes/model-call-execution.ts` | Validates against the node's declared ports, sends the envelope's prompt, and applies the decided effort through the one shared wire derivation. |
| `apps/api/src/slices/workflows/engine/interpreter.ts` | Derives the streaming disposition: a node whose output is consumed rather than displayed gets no `emit` seam. Memoizes the consumption walk. |
| `apps/api/src/slices/workflows/builder/ports.ts` | `persistedInputSchema` — derives the persisted field from the `accepts` claim the caller already made. |
| `apps/api/src/slices/workflows/builder/model-call.ts` | Persists the derived field so a definition can be built with an envelope input. |
| `apps/api/src/slices/workflows/compile/registry-fakes.ts` | The compile double honours the same derivation, plus a `classifyText` reducer for the compile/interpreter suites. |
| `apps/api/src/slices/workflows/engine/settlement.ts` | `anchorChargeKey` — the one anchor rule, exported. |
| `apps/api/src/slices/workflows/index.ts` | Publishes `anchorChargeKey` so the chat slice's display path resolves through it. |
| `apps/api/src/slices/chat/domain/settlement.ts` | The three money consequences: prompt fee on the first persisted charge, all-failed read off content, display anchor collapsed onto `anchorChargeKey`. |
| `apps/api/src/slices/chat/domain/settlement-storage.test.ts` | Unit pins for consequences 1 and 2. |
| `apps/api/src/slices/chat/domain/settlement.integration.test.ts` | End-to-end pins that an all-failed run raises and persists/bills nothing. |
| `.../engine/{node-registry,settlement,workflow-capabilities,interpreter}.test.ts`, `.../nodes/{model-call,smart-model}-execution.test.ts`, `.../compile/compile-definition.test.ts` | The behaviour pins listed below. |

## Tests added

| Test | Behaviour | Criterion |
| --- | --- | --- |
| `decideTurn > applies the declared effort fallback when no classifier answered` | Absent answer ⇒ declared fallback | reducer: declared fallback |
| `decideTurn > carries the prompt through to every consumer` | The envelope carries the prompt | envelope reaches consumers on one port |
| `decideTurn > resolves the effort dimension from its labelled line` | Parse | reducer: parse |
| `decideTurn > carries the model dimension line verbatim …` | Parse, model axis | reducer: parse |
| `decideTurn > reads only labelled lines, so an added dimension cannot shift another` | Labelled protocol | reducer: parse |
| `decideTurn > falls back when the answer names a level outside the ladder` | Closed-domain clamp + fallback | reducer: clamp, fallback |
| `decideTurn > leaves the model text empty when the answer names no model` | Unanswered axis | reducer: fallback |
| `decideTurn > parses the answer out of a reasoning-capable classifier value` | Inline reasoning stripped | reducer: parse |
| `TurnDecision > names the registered schema` / `rejects an effort outside the closed ladder` | Schema shape | registered schema |
| `DEFAULT_WORKFLOW_CAPABILITIES > registers the decision-envelope schema so json<turnDecision> resolves` | First schema-registry entry | registered schema, first entry |
| `… > registers the decision reducer over the prompt and an optional classifier answer` | Reducer tuple type | one registered reducer |
| `… > reduces a classifier answer into the decision envelope` / `… an absent classifier answer through the declared fallback` | Registered code = the pure function | one registered reducer |
| `createNodeRegistry resolveValuePorts > gives a modelCall declaring an input schema that schema as its input port` | Compile-time port derivation | additive input-schema field |
| `… > gives a smartModel declaring an input schema that schema as its input port` | The slot's other port declaration | additive input-schema field |
| `compileDefinition > accepts a modelCall consuming the registered schema it declares as its input` | Envelope flows through schema derivation | envelope flows through derivation |
| `compileDefinition > rejects raw text fed to a modelCall that declares a schema input` | Type wall holds | compile invariants untouched |
| (unchanged) `compileDefinition > rejects a single-input node whose registration declares two ports …` | The one-input-port rule still fires | compile invariants untouched |
| `createWorkflowExecutor — the streaming disposition > withholds the stream from a node whose output is consumed rather than displayed` | Zero stream events for the consumed node | classifier emits no stream event |
| `createModelCallExecution — the decision envelope > sends the envelope's prompt, never the envelope itself` | Consumer reads the envelope | envelope reaches consumers |
| `… > applies the classified effort to its own call within the cap admission priced` | Decision applied via the shared wire derivation | envelope reaches consumers |
| `… > leaves a pinned effort alone …` | A decision never rewrites a pinned dimension | (no criterion — guards the money-safe direction) |
| `… > sends no reasoning wire when the model has nothing to spend a budget on` | Non-reasoning model arm | coverage of the new branch |
| `… > fails closed on a malformed value where the envelope was declared` | Fail-closed | envelope fails closed on malformed |
| `createSmartModelExecution — the decision envelope > answers on the envelope's prompt …` | The slot's runtime port honours the field | additive input-schema field |
| `withStorageFees … > lands the shared prompt fee on the first PERSISTED charge, not the first charge` | Money consequence 1 | money consequence 1 |
| `withStorageFees … > still counts the shared prompt exactly once across the run` | Guard: no double-count | money consequence 1 |
| `collectPersistableCharges > is empty when a run charged only a generation that persists nothing` | Money consequence 2 (the signal) | money consequence 2 |
| `collectPersistableCharges > holds the charges whose content the run surfaced` | The signal's positive arm | money consequence 2 |
| `settlement.integration > terminal-fails a run whose only charge is a generation that persisted nothing` | Money consequence 2 end-to-end | money consequence 2 |
| `settlement.integration > terminal-fails a run whose only charge carries no persistable content` | The same signal for the shape-mismatch case | money consequence 2 |
| `anchorChargeKey — the one anchor rule` (3 tests) | Money consequence 3 | money consequence 3 |

## Self-gate

| Command | Result |
| --- | --- |
| `npx turbo typecheck --force --continue` | pass — 16/16, exit 0 |
| `pnpm arch:check` | pass — OK, 12 rules over 2035 files, exit 0 |
| `pnpm test:shared` | pass — 128 files, 3064 tests, exit 0 |
| `pnpm test:watch apps/api/src/slices/workflows apps/api/src/slices/chat` | pass — 58 files, 1234 tests, exit 0 (second draw; see attribution below) |
| scoped `vitest run --coverage --coverage.include=<owned files>` over the same scope | pass — statements 98.98, branches 97.57, functions 99.14, lines 99.65; every owned file ≥ 95 on all four |
| `pnpm test:api` | 1 file failed / 468 passed — `notifications/domain/templates/template-html.test.ts` only (§Known Breakage, concurrent push/notifications workstream; files I never touched) |
| `npx eslint .` from `apps/api` | pass — exit 0 |
| `npx eslint .` from `packages/shared` | pass — exit 0 |

**The lint set, derived from `git status` after the last edit anywhere.** Changed files group
into exactly two packages I touched — `apps/api` (18 files) and `packages/shared`
(`src/workflow.ts`) — so both were linted, each from its own package directory, exit status
captured on the command itself (`cmd > out 2>&1; echo "EXIT=$?"`). Other packages carry
working-tree modifications from concurrent/prior work that this task did not make and did not
lint. The first `apps/api` pass was red (prettier formatting, one nested assignment, two
complexity ceilings); all were fixed at the cause — the two complexity errors by extracting
`callInputOf` into `turn-decision.ts`, which also removed a duplicated input-shape branch from
two executions — and the suites and the repo typecheck were re-run after those edits
(1235 tests, 16/16).

### Attribution of failures observed

- **`chat/domain/regenerate.integration.test.ts` — 2 tests, first draw of the combined
  workflows+chat run.** `outcome: 'failed'` instead of `'succeeded'`. Passes in isolation
  (exit 0, 2/2) and passes on the second draw of the identical scope (1234/1234). It is the
  §Known Breakage `model_catalog` wipe/lock class: the file builds its turn definition from a
  catalog row another suite's wipe window can remove. Checked against the inverse rule as
  well — this task adds no fixture that writes shared state (every new test is in-memory
  except two `seedFixture()` settlement cases that touch no catalog row and no shared
  counter).
- **`notifications/.../template-html.test.ts` — 7 snapshot failures.** Listed verbatim in
  §Known Breakage as the single `apps/api` failure a scoped run shows; unrelated files.

## Acceptance criteria

1. **One registered decision-envelope schema — the FIRST entry in the capability schema
   registry.** Met. `DEFAULT_WORKFLOW_CAPABILITIES.schemas` was `[]`; it is now
   `[{ name: 'turnDecision', version: 1, schema: TurnDecision }]`. Evidence: the registry
   resolves `json<turnDecision>`, pinned in `workflow-capabilities.test.ts`.

2. **One registered reducer taking the prompt and an optional classifier answer, returning
   the envelope: parse, clamp, and the declared fallback in one pure function.** Met, with
   one interpretation recorded under §Deviations. `decideTurn` is the single pure function;
   the reducer registration's `run` does nothing but adapt the input tuple to it. Its inputs
   are `[textTag(), optionalTag(textTag())]` — the classifier node is `optional`, so its
   absence is an ordinary absent value, not a caught failure.

3. **Two additive schema fields.** Met as ONE, per the lane's pre-answer: the streaming half
   is derived, not declared. `inputSchema` is the only added field, on `modelCall` and
   `smartModel`. No existing definition changes shape — every shipped chat definition omits
   it, `Node.parse` defaults it absent, and the full workflows+chat suite (1234 tests) is
   green unchanged.

4. **Compile-layer invariants untouched: a test asserts the one-input-port rule is unchanged
   and still fires for a genuine violation.** Met. `portsAccepting` swaps the tag of a single
   port and never changes the arity, so `resolveValueNode(node, singleInput=true)` is
   untouched; the pre-existing `two-port-model` test still reports `node_config_unresolved`,
   and the new positive/negative compile pair shows an envelope node compiles with exactly
   one typed input and rejects a text producer with `type_mismatch`.

5. **The classifier emits no stream event; pinned by asserting zero events for that node.**
   Met, and derived rather than declared. Evidence in §The streaming disposition below.

6. **The envelope flows through schema derivation and fails closed on a malformed value.**
   Met. The declared `json<turnDecision>` port resolves through `zodFor` → the registered
   schema, both at compile (`compileDefinition` accepts the well-typed graph) and at runtime
   (`validateNodeInput` over `portsAccepting(...)`). A value whose `effort` is off the closed
   ladder fails the node. Note: that last test passed before the implementation too, because
   the pre-existing `toInputPart` already rejects a non-string; it is a regression pin rather
   than a discriminator, and its discriminating partner is the "sends the envelope's prompt"
   test, which was red.

### The streaming disposition, shown derived

`§Reasoning Effort 6` says streaming is withheld from any node whose output is *consumed
rather than displayed* — a property of the graph. The interpreter already computes exactly
that set (`consumedProducers()`, used to decide which values settlement persists), and the
streaming grant already lives on the resolved execution object. The whole change is one
conjunction at the single site where the node context is built:

```ts
const context = this.nodeContext(
  node.id,
  execution.streaming && !this.consumedProducers().has(node.id)
);
```

No schema field, no execution-registry change, no per-node flag — so there is no second
authority able to contradict the graph.

**Evidence no shipped definition lost a stream.** `consumedProducers()` skips feeds from the
`input` pseudo-node. Every shipped chat definition (`buildSingleModelTurn`,
`buildMultiModelTurn`, the smart and media turns) wires every node's `in` from
`inputs.ports[CHAT_TURN_INPUT]`, and no production definition constructs a `fanIn` at all
(`grep` over non-test sources: the only `fanIn` mentions are the engine, the builder, the
compiler and the estimator — no builder call site). So no shipped node is a consumed
producer. Empirically: the interpreter suite's 90 pre-existing tests, including the
multi-stream multi-model assertions, are unchanged and green, and the whole workflows+chat
scope (1234 tests) is green.

### The classifier's tokens shown never reaching the client

The new interpreter test builds the decision shape — `classify → fanIn → answer`, both model
calls streaming — and asserts the set of node ids that emitted anything is exactly
`{'answer'}`. The classifier node produces its value and emits zero events, because
`nodeContext` is built without an `emit` seam for it; a node with no `emit` cannot reach
`this.request.emit`, so there is no partial path.

### The reducer's parse, clamp and declared fallback as ONE registered pure function

`decideTurn(prompt, classifierAnswer?)` is the whole body:

- **parse** — inline reasoning stripped via `parseReasoningText`, then
  `parseClassifierAnswer` in its both-axes (labelled-lines-only) arm, reusing the shared
  parser rather than adding a second one;
- **clamp** — `resolveClassifiedEffort` resolves onto the closed canonical ladder through the
  dimension registry's own label matcher, so an answer naming something off the ladder cannot
  survive into the envelope, and the schema's `effort` domain makes an off-ladder value
  unrepresentable;
- **declared fallback** — `CLASSIFIER_EFFORT_FALLBACK`, applied to every non-answer (absent
  classifier and unresolvable answer alike). It is one exported constant, now also consumed
  by `smart-model-execution`'s `mediumFallback`, so the internal path and the reducer cannot
  drift.

The reducer registration is three lines that adapt the input tuple; there is no second call
site doing any of the three.

### The three money consequences

**1 — the prompt storage fee vanishes.** `withStorageFees` folded the whole prompt fee onto
the charge at *index 0*, on the reasoning that the first charge is always a succeeded,
persisting generation. A turn-level node runs in an earlier level than the siblings, so it
becomes index 0, and a charge with no content of its own is skipped at the charging commit —
the entire prompt fee silently dropped. Fixed by folding it onto the first **persisted**
charge (`collectPersistableCharges(request)[0]`).
*Pinned by:* `lands the shared prompt fee on the first PERSISTED charge, not the first
charge` — red before the fix with `expected 3000n to be 0n` (the fee sat on the
non-persisting charge), green after, with the fee on the sibling that persists.

**2 — the all-siblings-failed detector stops firing.** It read `request.charges.length === 0`.
With a turn-level charge present, an all-fail turn has one charge, the persistable set is
empty, every charge is skipped, and settlement **commits successfully having persisted
nothing and billed nothing while the client is told the turn succeeded.** Fixed by reading
the signal off content: `collectPersistableCharges(request).length === 0` raises
`AllBranchesFailedError`. This subsumes the previous "charges arrived but none persistable"
branch, which returned an empty map and produced exactly that silent empty success for the
media-shape-mismatch case; it now raises too, which is the same correct outcome (client told
it failed, nothing saved, nothing billed).
*Pinned by:* `collectPersistableCharges > is empty when a run charged only a generation that
persists nothing` (unit) and `settlement.integration > terminal-fails a run whose only charge
is a generation that persisted nothing` (end-to-end: rejects, zero `usage_records`, zero
messages). The unit test was red with `collectPersistableCharges is not a function`; the
integration test is new and exercises the exact shape a turn-level node creates.

**3 — the anchor rule had two hand-maintained implementations.** The debit path
(`anchorContentItemId` in the engine's charging commit) and the display path
(`resolveDisplayAnchorKey` in the chat slice's settlement) each implemented
"own key, else strip the last `#` segment", asserting agreement in prose. Collapsed onto one
exported `anchorChargeKey(key, persistedContentFor)`; both callers now resolve through it, so
a displayed cost cannot land on a different content item than the debit. This is also what
makes C2's run-level anchor a change to one function rather than two.
*Pinned by:* `anchorChargeKey — the one anchor rule` (3 tests: own content, suffixed
auxiliary, neither), red with `anchorChargeKey is not a function`, and by the existing
`createChargingCommit — suffixed auxiliary charge anchoring` suite plus the chat settlement
integration suite (61 tests) which exercise both callers.

## Deviations, with reasons

1. **"Two additive schema fields" delivered as one.** Directed by the lane's PRE-ANSWERED
   block: streaming is derived from the graph, so a declared per-node flag would be a second
   authority for a fact the definition already fixes. `live-execution-registry.ts` and
   `execution-registry.ts` were not touched, as instructed.

2. **Files outside C1's stated list.** The pre-answer already granted
   `engine/node-registry.ts`, `engine/model-ports.ts`, `engine/interpreter.ts` and the Smart
   Model slot's two port declarations. Beyond those I also touched, and am flagging:
   - `builder/model-call.ts` + `builder/ports.ts` — without persisting the field from the
     `accepts` claim, no definition can be *built* with an envelope input and the mechanism
     is unreachable. Derived from `accepts` rather than declared separately, so there is one
     authority.
   - `compile/registry-fakes.ts` — the compile suite's double must honour the same derivation
     or the compile-layer criterion cannot be exercised.
   - `chat/domain/settlement.ts` and `engine/settlement.ts` — the three money consequences,
     assigned to this task by the orchestrator's brief. The plan's C2 section assigns the
     anchor change to C2; C2's own criteria (a *run-level* anchor) now change one function
     instead of two.
   - `workflows/index.ts` — publishes `anchorChargeKey` for the chat slice.

3. **"Clamp to the printed ceiling" read as the closed-domain clamp.** A registered reducer
   sees only its graph inputs, so the turn's *presented* option set is not reachable from it;
   the reducer clamps onto the closed canonical ladder (an off-ladder answer cannot survive),
   and the per-model completion-cap clamp stays in `pickClassifiedEffortPlan` — the one shared
   wire derivation the spec assigns to the consumer ("applies the decision to itself through
   the one shared wire-derivation function"). If the intended reading was a third reducer
   input carrying the presented set, that is a graph-shape decision this task did not have a
   producer for.

4. **The envelope's `effort` is always present; a consumer with a pinned effort ignores it.**
   The reducer cannot know which axes a given turn opened (it sees only the answer), so it
   always produces an effort — the declared fallback when none resolved. A consumer whose own
   `params` already carry a reasoning wire has a pinned effort and is left alone, which keeps
   the §Turn Stories 1 shape (effort pinned, model open) correct. Pinned by `leaves a pinned
   effort alone`.

5. **The `smartModel` *builder* was not widened to accept an envelope input.** Its `in` port
   is typed `Port<AssignableTag<TextTag>>`; making it generic changes inference at every call
   site. The slot's two *port authorities* (compile registry and runtime declaration) honour
   `inputSchema` and the runtime reads its prompt through `callInputOf`, so the slot works
   when handed an envelope — only the typed builder convenience is missing, and C2 owns the
   slot's consumption.

## Concerns and limitations

- **The internal Smart Model classifier path still exists.** C1 builds the mechanism; C2's
  criteria name the deletion. Nothing is duplicated in the meantime — the declared fallback
  constant and the answer parser are shared, not copied — but two classifier *paths* coexist
  until C2 lands.
- **`decidingNode`-shaped definitions are not built by any shipped code yet.** The mechanism
  is exercised by unit and compile tests and by the interpreter end-to-end; the first
  production definition using it is C2/C3's.
- **Consequence 2 changes an existing behaviour deliberately.** A run whose charges carry no
  persistable content used to commit an empty success; it now raises. Two integration
  expectations were updated to match. If any caller depended on the empty-success shape, this
  is where it would surface — none was found (`AllBranchesFailedError` is handled by the
  interpreter as a friendly `all-branches-failed` outcome, never a Sentry defect).
- **`decideTurn` reads labelled lines only.** The shared parser's unlabelled tolerance (a
  single-dimension call whose model answers bare) is not used by the reducer, per
  §Reasoning Effort 6's "one labelled line per dimension". The cost of a model ignoring its
  label is the declared fallback, which is the cheap direction.

## Confidence

**High** for the mechanism and for money consequences 1 and 3: each is small, pinned by a
test that was red for the stated reason, and covered by a green repo typecheck, arch:check,
and the full workflows+chat scope.

**Medium** for money consequence 2 only in the sense that it changes a live behaviour
(empty-success → raise) that no criterion previously described; the change is what the spec
now states normatively, and both directions are pinned, but it is the one place where a
reviewer should confirm the intent rather than the implementation.
