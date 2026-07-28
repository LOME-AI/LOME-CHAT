# C3 — impl report 1 — NEEDS_CONTEXT (zero files changed)

## Objective

Wire the turn-level classifier node into the shipped multi-model `auto` definition, closing the
two under-reserve terms (full history, custom instructions) and the classifier double-pricing
before they bind.

## Status

**NEEDS_CONTEXT. No file was modified, no test written.** The task's central change — making a
classifier `modelCall` node behave as a classifier — is not expressible from C3's granted file
set, and the missing authority is a persisted node field in `packages/shared/src/workflow.ts`
plus its builder. This is not a category claim: the concrete artifact I cannot produce is named
below, with the two alternative routes and the verified reason each is closed.

Everything else in the brief hinges on that node existing: the double-pricing fix, both
under-reserve pins, the `onError: 'skip'` degrade pin, the presented-subset narrowing, and every
one of the eleven acceptance criteria that mention "the classifier".

## The blocker, stated exactly

A classifier that is an ordinary `modelCall` must differ from a sibling answer call in four ways.
Three of them are what the deleted internal path did (`git show
HEAD:apps/api/src/slices/workflows/nodes/smart-model-execution.ts`, `classifierRequest`, ~`:196-211`):

| # | Required                                                                          | Today, for a plain `modelCall`                                                                                            |
| - | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 1 | Input = classifier system prompt (marker + labelled option lines) + truncated context | Input = whatever the edge carries, verbatim (`model-call-execution.ts:198`)                                              |
| 2 | No conversation history                                                            | `ctx.history` forwarded (`model-call-execution.ts:205,212`)                                                                |
| 3 | No custom instructions                                                             | `ctx.customInstructions` forwarded (`model-call-execution.ts:206,213`)                                                    |
| 4 | Output capped at `CLASSIFIER_OUTPUT_TOKEN_CAP`                                     | Only whatever `params.maxOutputTokens` says — expressible today, the one of the four that is not blocked                  |

All four require the execution to **recognise** that this node is the turn's classifier, and to
know its candidate list and open dimensions (items 1 and 4). `run(node, input, ctx)` receives the
whole `Node`, so recognition is possible in principle — but the `modelCall` variant
(`packages/shared/src/workflow.ts:53-73`) carries no field that can say so: `id`, `version`,
`out`, `optional`, `onError`, `inputSchema`, `model`, `params`, `in`, `tools`, `maxSteps`,
`promptInputTokens`.

**Route A — smuggle the marker through `node.params`: structurally impossible, not merely a
smell.** `params` becomes `request.parameters`, and the language adapter parses it with
`z.strictObject` (`apps/api/src/slices/models/adapters/language-adapter.ts:54-73`): any unknown
key throws `invalidRequestError('Unsupported inference parameters …')`. A marker in `params` fails
every classifier call at the provider boundary. Independently, the repo already ruled this shape
out in writing for exactly this class of data — `promptInputTokens` "lives on the node (NOT in
`params`) and is NEVER forwarded to the provider — it is not a call parameter"
(`packages/shared/src/workflow.ts:67-72`).

**Route B — carry the marker on the input value, like C1's `TurnDecision` envelope.** The
`inputSchema` field exists and the port derivation honours it, so a classifier node could declare
`accepts: jsonTag('<something>')` and `model-call-execution.ts` could branch on it exactly as it
branches on `decisionOf(input[0])`. Closed for two reasons: the schema must be registered in
`engine/workflow-capabilities.ts` (ungranted), and whatever produces that envelope is a reducer,
which sees only graph values — while the truncated context needs the **latest assistant message**,
i.e. `ctx.history`, which reaches node executions only. The one context that holds history is the
very place that cannot tell it is the classifier.

**Consequence if wired without a marker (why this is a blocker and not a quality concern).** The
node would send the user's prompt plus full history plus custom instructions under the *base chat*
system prompt (`language-adapter.ts` sets `system = buildTurnSystemPrompt(…)` unconditionally,
~`:424-437`), so the model returns an ordinary assistant answer. `decideTurn` would parse no
labelled line, `resolveClassifiedEffort` would return undefined, and every turn would take the
fallback — a paid provider call per turn that decides nothing, on top of the two under-reserve
terms. That is worse than the interim regression C3 exists to remove.

## What IS already landed, and is not the problem

Verified so the orchestrator does not re-derive it:

- The **consumer** half of the mechanism is complete. `paramsApplyingDecision`
  (`model-call-execution.ts:170-181`) already carves the decision's effort into a sibling's own
  cap through the shared plan, so criterion "the chosen effort applies to all siblings, resolved
  per model, each sibling's wire cap is its own B + its own H" needs no new code — only a producer.
- The **graph shape** is expressible from granted files: `modelCall`, `fanIn` and `workflowInputs`
  all reach `chat/domain/turn-definition.ts` through the workflows barrel
  (`workflows/index.ts:51` re-exports `./builder/index.js`), and
  `engine/smart-model.integration.test.ts:168-202` is a working reference definition of exactly the
  classifier → `decideTurn` → consumer shape.
- **`onError: 'skip'` is expressible** — `NodeOptionsBase` carries `optional`/`onError`, and
  `decideTurn`'s second input is `optionalTag(textTag())`
  (`engine/workflow-capabilities.ts:148-152`), i.e. built for an absent classifier answer. The
  brief's second NEEDS_CONTEXT trigger does **not** fire: no definition-shape change is needed
  for the graceful degrade.
- **The brief's first trigger does not fire either — the spec settles truncate-vs-reprice.**
  `BILLING.md` §Reasoning Effort 6 ("one call … sharing one truncated context (4,000-character
  cap)") and §Math & Terms `classifierReserve` ("provider leg only") both describe the priced
  quantity as the truncated context. So the answer is **truncate what the node is sent**, for both
  history and custom instructions, and no ruling is needed on that axis. I record it because it is
  the one design question in this task I could answer from the spec.

## Findings surfaced while reading (each independently verifiable)

1. **Two content helpers are now orphaned production code.** `truncateForClassifier`
   (`workflows/nodes/classifier-context.ts`) and `buildClassifierMessages`
   (`workflows/nodes/classifier-messages.ts`) have **zero** non-test callers after C2's deletion
   (grep over `apps` + `packages`, excluding `node_modules`/`dist`). They are the helpers C3's
   wiring is supposed to re-consume, so they are correctly still on disk — but until it lands,
   `pnpm lint:unused` (knip) has two more findings than the two §Known Breakage attributes to
   other work.
2. **`CLASSIFIER_OUTPUT_TOKEN_CAP` has no production consumer outside the pricing core**, which
   confirms routed item (a) precisely: its only non-test references are
   `packages/shared/src/affordability/estimate/classifier-line-item.ts` (the reserve formula) and
   its own declaration in `affordability/smart-model/eligible-models.ts:13`. Nothing applies it to
   a request. The reserve prices a cap the request does not enforce.
3. **The double-pricing item's blast radius is narrower than its wording, and that changes the
   pin.** For a multi-model `auto` turn there is no `smartModel` node at all, so a turn-level
   classifier node is priced once and nothing double-counts. The double count arises only where a
   `smartModel` node coexists with a turn-level classifier — the Smart-Model-as-sibling turn and
   `compileAutoEffortTurn`'s pinned+auto turn. Whoever implements this must state the reserve for
   both shapes, not one.
4. **A spec-vs-mechanism conflict the double-pricing fix walks into, needing a ruling.** If the
   classifier node is priced by the generic `modelCeiling` path, then on a *persisting* turn
   `tokenNodeStorage` (`estimate-run.ts:66-72`) adds tier-sized **output storage** for the
   classifier's own output leg. `BILLING.md` §Math & Terms `classifierReserve` and §Reasoning
   Effort 7 both say no storage is reserved or charged for the classifier, and
   `estimate-run.ts:520-524` implements that today by *positively filtering* the reserve to
   provider items. The generic path cannot express that exclusion without recognising the node —
   the same marker again. Direction is safe (over-reserve), amount is wrong, and the doc statement
   would become false unless the exclusion is preserved.
5. **The refusal-mapping item's owning file is not the one in the Files list.** §C3 grants
   `chat/routes.ts` "(refusal mapping only)", but the collapse of all three admission reasons onto
   one wire code happens in `chat/domain/runtime.ts:599-613` (`return { admitted: false, code:
ERROR_CODES.INSUFFICIENT_ADMISSION }`), whose own comment asserts "the reason must not reach the
   client" — the assertion §C3 overturns. Widening it also touches
   `packages/shared/src/error-codes.ts:162` (`INSUFFICIENT_ADMISSION → noticeText('send_cannot_start')`)
   and `packages/shared/src/affordability/notices.ts:81,223` (the `send_cannot_start` entry the
   brief requires deleted). The typed reason set itself
   (`billing/domain/admission.ts:54`) already carries all three conditions, so billing needs no
   change. None of those four files is granted.
6. **The two-fallbacks collapse cannot be done from C3's files.**
   `CLASSIFIER_EFFORT_FALLBACK = 'medium'` is declared in
   `workflows/nodes/turn-decision.ts:75` and consumed there (`:85,99`) and in
   `workflows/nodes/smart-model-execution.ts:13,142`. Deleting the constant edits two ungranted
   files; leaving it while `chooseFrom` follows the spec keeps two numbers answering one question.
7. **The one item that is fully inside the grant** is the dead `_pinned` parameter: the declaration
   is `models/domain/smart-model-candidates.ts:188-205` and the sole call site is
   `chat/domain/smart-model-turn.ts:384` — both granted, removable in one edit. I did **not** do it
   alone: a money-flagged task with two auditors, opened to remove a user-visible regression,
   should not return a 4-line rename as its delivery while the regression stands. It is ~2% of the
   task and would consume a full audit cycle.

## What would unblock this task

The minimum additional grant, in dependency order:

1. `packages/shared/src/workflow.ts` — one additive optional field on the `modelCall` variant
   declaring that this node is the turn's classifier and carrying what the prompt needs (the
   candidate id/description list and the open dimensions), mirroring `smartModel.classify`'s shape
   so `smartModelClassifierDimensions`' authority is reused rather than copied. Server-derived
   definition data, so hash-safe by the same argument the existing fields carry. **Ships a
   `packages/shared` test and, per Global Constraint 10, a repo-wide typecheck.**
2. `apps/api/src/slices/workflows/builder/model-call.ts` — pass the field through (one spread).
3. `apps/api/src/slices/workflows/nodes/{classifier-messages,classifier-context}.ts` — read-only
   in the likely shape (imported by `model-call-execution.ts`), but naming them explicitly avoids a
   second stop if the envelope budget needs adjusting once the option lines are inside it.
4. `apps/api/src/slices/chat/domain/runtime.ts` + `packages/shared/src/error-codes.ts` +
   `packages/shared/src/affordability/notices.ts` — the refusal-mapping item and the
   `send_cannot_start` deletion (finding 5).
5. `apps/api/src/slices/workflows/nodes/turn-decision.ts` +
   `apps/api/src/slices/workflows/nodes/smart-model-execution.ts` — the two-fallbacks collapse
   (finding 6).
6. A ruling on finding 4 (classifier output storage), because both available answers change a
   normative `BILLING.md` sentence or the reserve's amount.

An alternative that needs no schema change is worth naming so it is rejected deliberately rather
than by omission: assemble the classifier prompt at run start and pass it as a **second workflow
input**. It relocates the problem rather than solving it — items 2 and 3 (history, custom
instructions) still need recognition inside `model-call-execution.ts`, and it puts conversation
excerpt content into the run-start payload assembled in `chat/domain/runtime.ts`, also ungranted.

## Self-gate

Not run. No file was modified, so there is nothing to gate: TDD's first step (a failing test for
the behaviour) cannot be written without deciding the blocked design question, and writing one
against a guessed shape is precisely what this stop exists to avoid. `git status` at task start
and at task end are identical (258 entries, all attributable to C1/C2/B8's uncommitted work and
the concurrent workstreams).

## Acceptance criteria

Every criterion naming the classifier — all eleven of §C3's list, plus the four C2-audit items,
plus routed items 1–3, plus the B8 items — is **not met**, one cause: the producer cannot be built.
The `_pinned` removal (inherited item) is **not met by choice**, reasoned in finding 7.

## Confidence

**High** that the blocker is real and correctly located. The two closing arguments are runtime
facts, not judgements: `z.strictObject` on call parameters (Route A), and history reaching only
node executions while schema registration and reducer code sit in ungranted files (Route B). Both
were read this session at the cited lines.
