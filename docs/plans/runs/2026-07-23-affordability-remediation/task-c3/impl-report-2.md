# C3 — impl report 2 — the derived-classifier foundation (Option A), wiring NOT landed

## Objective

Wire the turn-level classifier node into the shipped multi-model `auto` definition, closing the
two under-reserve terms and the double-pricing before they bind, per the founder's Option A ruling
(§The classifier-marker question).

## Status, stated plainly

**Partially delivered, and the missing half is the wiring itself.** Everything Option A's seven
items require of the *mechanism* is built, green, and gated: the derivation, both withholdings,
the base-prompt suppression, the storage class rule, and the double-pricing fix. What is **not**
built is the multi-model `auto` **definition** (classifier node + `decideTurn` fanIn + siblings
consuming the envelope) and the route-side prompt rendering, so `auto` on a multi-model turn still
resolves nothing and the interim product regression stands.

Three of the four required pins are green and were each watched red first. The fourth
(`reserve ⊇ bill` on a real assembled request) cannot be closed until a request exists to assemble;
its **cause** — the unpriced preamble — is closed, and the amount is measured below.

I stopped at the boundary deliberately rather than half-wiring: a definition whose classifier input
no route supplies fails every run at validation, which is worse than the regression it replaces.
The remaining work is enumerated at the end in dependency order, with the decisions I resolved
along the way so the next cycle does not re-derive them.

## Files changed

| File                                             | Why                                                                                          |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `packages/shared/src/workflow.ts`                | `TURN_DECISION_REDUCER`, `isTurnClassifierNode`, `consumedProducerIds` — the one derivation  |
| `packages/shared/src/index.ts`                   | publishes those three                                                                        |
| `packages/shared/src/inference.ts`               | `routingOnly` on `InferenceRequest` (founder ruling 7)                                       |
| `apps/api/.../models/adapters/language-adapter.ts` | suppresses the base preamble on a routing-only call, via an extracted `systemPromptFor`    |
| `apps/api/.../workflows/engine/interpreter.ts`   | withholds history + custom instructions from a derived classifier; carries the derived fact  |
| `apps/api/.../workflows/engine/execution-registry.ts` | `NodeRunContext.routingOnly` + two docblocks the withholding falsified                  |
| `apps/api/.../workflows/nodes/model-call-execution.ts` | marks the provider request routing-only                                                |
| `apps/api/.../models/domain/estimate-run.ts`     | storage class rule; classifier double-pricing; three falsified comments                      |
| `apps/api/.../models/domain/smart-model-candidates.ts` | dead `_pinned` parameter removed                                                       |
| `apps/api/.../chat/domain/smart-model-turn.ts`   | the `_pinned` call site — the other half of that edit                                        |
| `apps/api/.../chat/domain/turn-definition.ts`    | one comment the storage class rule falsified                                                 |
| `apps/api/.../workflows/compile/registry-fakes.ts` | registers the REAL reducer name, so the derivation is tested on the shape production emits |
| 6 `*.test.ts` files                              | the pins below                                                                               |

## The four required pins

Each was run and watched red before the change, for the stated reason.

| Pin                                                            | Red evidence                                                                                        | Now                                    |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Classifier request carries **no `history`, no `customInstructions`** | `interpreter.test.ts` — classifier saw `HISTORY` and `'answer only in French'`; the sibling's identical assertion passed in the same run, so the harness was proven capable of both answers | green (2 tests + a sibling control)    |
| Persisting definition holds **no output-storage term for a consumed node** | `estimate-run.test.ts` — got `BASE_1000 + 1,200,000` (the free-tier output storage) where `BASE_1000` was expected | green (+ a sink control asserting the storage IS still held) |
| Classifier request's `parameters.maxOutputTokens === CLASSIFIER_OUTPUT_TOKEN_CAP` | **not closed** — the constant still has no production consumer                                     | **red**; it is stamped by the builder, which is the unlanded half |
| `reserve ⊇ bill` on the real assembled request, counting the base preamble | **not closed as an end-to-end pin** — no assembled classifier request exists yet                    | its **cause** is closed and measured below |

Pin 3 and pin 4 are the two that depend on the definition existing. Nothing about them is
blocked — they are unbuilt.

## Amounts

**The unpriced preamble, measured rather than estimated.** `buildTurnSystemPrompt` at a fixed
clock renders **1,739 characters**. The classifier reserve prices `classifierReserveChars` =
**4,929 characters** for a two-model option list (the template + option lines + the 4,000-character
context cap). So the preamble was **+35.3%** on the priced input basis (1,739 / 4,929), unreserved.

**This corrects the plan's figure.** §The classifier-marker question records the preamble as
"~2.6 KB … roughly +2.3 KB on the 4,000-char priced budget … ~55% input-leg overshoot". The
measured value is 1,739 chars, so the overshoot is **35.3%** against the priced basis (43.5% if
measured against the 4,000-char context term alone, which is not the whole priced basis). The
direction and the ruling are unaffected — it is real, unpriced input — but the magnitude in the
plan is high by roughly a third. Surfaced, not edited.

**Reserved vs billed classifier input**, per Option A, at the fixture above:

| | reserved | billed, before | billed, after |
| --- | --- | --- | --- |
| classifier input | 4,929 chars | 4,929 + 1,739 (preamble) + **full history** + **custom instructions** | ≤ 4,929 chars |

The "before" column is what a wired classifier node would have sent under the tree as C2 left it —
which is why the plan required this closed before the wiring, not after. The remaining inequality
is now slack in the safe direction: the emitted context is capped at 4,000 chars including its own
envelope (`classifier-context.ts` subtracts the section labels from the budget), and the template
is priced at its full rendered length.

**Double-pricing, both shapes** (estimator fixture: one 1,000-context model at 2,500/10,000
nano per token, two candidates; `BASE_1000` = 12,500,000n, classifier reserve = 26,642,500n):

| smartModel slot | before | after |
| --- | --- | --- |
| **coexisting** — fed the decision from outside (`inputSchema` set), so a turn-level classifier node is priced separately | 39,142,500n (12,500,000 + 26,642,500) **on top of** the classifier node's own price | **12,500,000n** — no internal reserve |
| **pure** — the slot classifies for itself, no external decision | 39,142,500n | **39,142,500n**, unchanged |

Pinned by one test asserting both figures in the same run, so the difference is the tested fact
rather than two separate assertions that could drift apart.

## Design decisions taken inside the ruling

- **`consumedProducerIds` is a second shared derivation, not a copy of the interpreter's walk.**
  The interpreter walks *compiled* inputs; the estimator has only raw nodes. Rather than a mirrored
  walk (Global Constraint 5), the definition-level walk lives beside the predicate in
  `workflow.ts`. Container feeds need no exclusion there: a body reads its container's reserved
  virtual port, so the id it names is the container's, never a value node's — every id a value node
  contributes therefore means its `out` is genuinely read. Recorded because the safe direction is
  counter-intuitive here: **over**-marking a node as consumed would **under**-reserve.
- **The storage exclusion is the class rule the founder ruled, not a classifier exception**, and it
  is stated over what settlement can persist. Verified against the interpreter: settlement receives
  `sinkOutputs()`, and a sink is a node no dataflow edge consumes.
- **`routingOnly` travels on the context as well as being withheld.** Withholding cannot express
  the preamble, because the adapter *adds* it. The two are not redundant: history/instructions are
  absent (ruling 2's byte-for-byte C1 move), and the request field is the only way to suppress
  something the caller never supplied.
- **The double-pricing key is `smartModel.inputSchema !== undefined`** — the analyst's free win,
  the same already-declared field the runtime reads for the same fact. No new surface.

## Deviations, and grants I used beyond the Files line

- **`apps/api/.../workflows/engine/{interpreter,execution-registry}.ts`** are not on §C3's Files
  line, but ruling 2 directs the interpreter edit explicitly and the orchestrator ruled the
  execution-registry permitted for a derived fact. Flagged so the auditor is not surprised.
- **`workflows/compile/registry-fakes.ts`** (shared test double) now registers the real
  `decideTurn` name. Without it the derivation would be tested against a graph production never
  produces — the vacuity shape §Global Constraints warns about.
- **`packages/shared/src/index.ts`** publishes the three new symbols. `workflow-capabilities.ts`
  still declares the reducer name as its own string literal; making it import
  `TURN_DECISION_REDUCER` is a one-line edit in a file I was not granted, and until it happens the
  name has **two** homes. It is not currently a drift risk in the tested sense — the fakes and the
  derivation both use the shared constant, and a rename of the live registration would redden the
  smart-model integration test — but it is exactly the mirrored-constant shape this run removes.
  **Raised for the next cycle's grant.**

## Vocabulary sweep (standing rule)

Swept by grepping each changed mechanism's words across every owned file, not by re-reading the
diff. Five mechanisms: the unconditional base preamble · run-scoped context reaching every node ·
unconditional per-node output storage · `_pinned` · the smartModel-internal classifier reserve.

**Five falsified comments found, four of them outside the diff's hunks:**

1. `execution-registry.ts:49` — "The same array reaches every node of the run" (history). Rewritten
   to state what absence *means* rather than a universal the withholding now breaks.
2. `execution-registry.ts` (customInstructions docblock) — same class, same fix.
3. `estimate-run.ts` module docblock — "output storage per answer-producing node … the classifier
   reserve's own storage". Both halves false: storage is now per *persistable* node, and the reserve
   never carried storage (the positive filter excluded it long before this change).
4. `estimate-run.ts` `estimateSmartModelNode` docblock — "the classifier's BOUNDED worst-case
   reserve **plus** the MAX over candidates" is false for a slot fed the decision from outside.
5. `turn-definition.ts:184` — "tier-sized output storage per node".

Each was rewritten to state what the code guarantees rather than to quote a quantity that a later
edit can falsify. `_pinned`'s vocabulary (`_pinned`, "selects nothing", "Retained only because")
greps clean repo-wide: **nothing else found**.

**One wrong figure found and NOT changed** (pre-existing, not falsified by me, so out of surgical
scope): `estimate-run.test.ts` has a comment reading `provider = BASE_1000 = 14,375,000` while
`BASE_1000` is `12_500_000n` (asserted correct at its declaration). Reported rather than fixed.

## Self-gate

| Command | Result |
| --- | --- |
| `pnpm test:shared` | **pass**, exit 0, full coverage gate; `workflow.ts` and `inference.ts` both 100/100/100/100 |
| `pnpm test:api` | **7 failures, none mine** — `notifications/domain/templates/template-html.test.ts` (`welcome`, `password-changed`, `two-factor-enabled`, `two-factor-disabled`, `account-locked`, `account-deleted`, `chargeback-lock`), the documented snapshot family owned by the notifications workstream. 733 files green. The run then hit the documented coverage-merge `ENOENT` crash, so **no coverage table printed** — gated per-file below instead. |
| scoped coverage, one `--coverage.include` per run | `estimate-run.ts` 100/98.92/100/100 · `interpreter.ts` 98.37/**95.63**/97.59/99.47 · `model-call-execution.ts` 100/98.13/100/100 · `language-adapter.ts` 97.36/96.38/100/100 — all ≥ the 95 floor, each table verified to list the file claimed |
| `turbo typecheck --filter=@hushbox/api --filter=@hushbox/shared --force` | **pass**, 2/2, uncached |
| `eslint` from `packages/shared` on my 4 changed files | **exit 0** (after fixing one `sonarjs/no-alphabetical-sort` and prettier) |
| `eslint` from `apps/api` on my 14 changed files | **exit 0** (after fixing three real findings: two complexity ceilings and `unicorn/no-array-callback-reference` — by extracting `systemPromptFor` and `clientContextFor`, never by disabling a rule) |

**No chat-integration failures appeared in the api sweep — and per §Known Breakage that proves
nothing**, because the failing set there moves between identical runs. I checked the inverse
direction the section demands: my diff adds no catalog fixture and writes no shared state, so there
is nothing of mine that could be making that suite noisier.

## Acceptance criteria

**Met:** the `_pinned` removal (both sides, one edit) · the double-pricing close, both figures · the
classifier's history exclusion · the classifier's custom-instructions exclusion · the storage class
rule · the base-preamble suppression (ruling 7).

**Not met — all blocked on the unlanded definition wiring, none blocked on a decision:** multi-model
`auto` resolving through the classifier · the ladder pruned against pinned siblings · per-candidate
effort ceilings · the `admissible`-not-`affordable` pin · the post-admission engine pick · one call
carrying both dimensions on labelled lines · the effort applying to all siblings · explicit level
never rewritten to `auto` · web-search and trial `auto` arms · partial-success billing over three
outcomes · fork tip · the `reserve ⊇ bill` fuzz property · the output-cap pin · the presented-subset
narrowing · the two-fallbacks collapse · the refusal-mapping widening and the `send_cannot_start`
deletion · the fourth `B + H` site pin · B8's cross-implementation clamp-order amount.

## What the next cycle needs, in dependency order

1. **Publish or move `classifier-context.ts` + `classifier-messages.ts`** (ruling 4 says pick one
   and say which). My recommendation: **publish through the workflows barrel** — they are consumed
   by `chat` for prompt assembly, and moving them into `chat` would put the truncation budget that
   the *reserve* prices further from the engine that spends it.
2. **A second workflow input** for the rendered classifier prompt (`CHAT_TURN_INPUT`'s sibling).
   Verified reachable: `ContentValue` is `text | bytes | media` and the route already supplies
   `{ [CHAT_TURN_INPUT]: { kind: 'text', … } }` at four send sites.
3. **`buildMultiModelTurn` / `compileMultiModelTurn`** grow the classifying shape: `modelCall`
   (`optional: true`, `onError: 'skip'`, `params.maxOutputTokens = CLASSIFIER_OUTPUT_TOKEN_CAP`,
   `promptInputTokens` = the reserve's own token basis) → `fanIn(TURN_DECISION_REDUCER)` →
   siblings with `accepts: jsonTag(TURN_DECISION_SCHEMA_NAME)`. `paramsApplyingDecision` already
   applies the decided effort per sibling, so the consumer half needs nothing.
   **Watch out:** `compileMultiModelTurn` holds a `ModelPricingResolver`, not a catalog list, while
   `pickEffortClassifier` needs the list — that path has to move to `listDescriptors` +
   `snapshotResolver`, the way `smart-model-turn.ts` already does.
4. **Route rendering** with the `admissible` narrowing applied (ruling 6: the estimator keeps
   pricing the declared domain, so **the hold is knowingly larger than the narrowed prompt needs** —
   that is the accepted over-reserve, not a defect to fix).
5. Then the dependent pins, and the independent leftovers (refusal mapping, two-fallbacks collapse,
   fourth `B + H` site).

## Concerns

- **The reducer name has two homes** until `workflow-capabilities.ts` imports the constant (above).
- **`interpreter.ts` branch coverage is 95.63%** — over the floor, but the thinnest margin among the
  files I touched.
- The **1,739-char** measurement is one render at one fixed clock; the preamble renders the current
  date, so the figure moves by a character or two across dates. The conclusion (real, unpriced,
  now suppressed) does not depend on the exact value.

## Confidence

**High** on what landed: every pin was watched red for a stated reason, each red was diagnosed
rather than assumed, and the two control assertions (the sibling that still receives context, the
sink that still reserves storage) mean neither green comes from a test that cannot fail.
**High** that the remainder is unblocked — every missing piece is construction against a ruled
design, not another decision.
