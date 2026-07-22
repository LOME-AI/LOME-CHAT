# T6 — Persistence doctrine: same-field storage + history strip — impl report 1

## Objective

At persist, the final assistant text is the T3-serialized (reasoning, answer) when
reasoning text arrived (else answer verbatim; o-series persists answer only); history
replay strips reasoning via the shared parser at a seam covering BOTH history sources;
settlement char-counts operate on the stored field as-is (R2); no schema migration.

## Files changed

- `apps/api/src/slices/chat/domain/history-replay.ts` — NEW: `stripReplayHistory`, the
  G8 strip over `ChatHistoryMessage[]` (assistant-only parse via shared
  `parseReasoningText`; user text never interpreted; reasoning-only entries dropped;
  identity return when nothing strips).
- `apps/api/src/slices/chat/domain/history-replay.test.ts` — NEW: 7 tests (both
  client-history sources, regenerate shape, user-verbatim defense, identity, drop,
  empty).
- `apps/api/src/slices/chat/domain/runtime.ts` — wired the strip into
  `prepareStartRequest` via new `withReplayHistoryStripped` (every run — paid, trial,
  regenerate, smartModel — passes this one seam before the engine); one import line.
- `apps/api/src/slices/chat/domain/runtime.test.ts` — 3 new `prepareStartRequest` pins
  (strip on text run, strip on media/mint run, identity when clean) + import line.
- `apps/api/src/slices/workflows/nodes/model-call-execution.ts` — persist seam:
  `CallAccumulator.reasoning` accumulates `reasoning-delta`; new `textValueOf` builds
  the resolved value via shared `serializeReasoningText` on BOTH the success and
  aborted-partial paths; import line. **This file is outside the plan's T6 Files glob —
  see Deviations.** Additive only; the file also carries a foreign uncommitted diff
  (video-duration pre-flight + T5's `no_reasoning_endpoints` line) which I did not
  touch. My lines: the import block entry, the `reasoning` field + doc on
  `CallAccumulator`, `reasoning: ''` in the initializer, the `reasoning-delta` branch
  in `absorb`, `textValueOf` + doc, and the two `accumulator.media ?? textValueOf(...)`
  substitutions.
- `apps/api/src/slices/workflows/nodes/model-call-execution.test.ts` — new describe
  block (6 tests) + import line; additive at end of file.
- `apps/api/src/slices/chat/domain/settlement-storage.test.ts` — 1 additive doctrine
  pin (stored field char-counted as-is when it embeds reasoning) + import line.
  `settlement.ts` itself: **zero edits** (criterion is "no special casing" — none
  exists; `responseChars = output.text.length` at settlement.ts:1119 already counts the
  stored field verbatim).

No schema migration; no `packages/db` change; no shared-module change (T8 already
exported the parser through the barrel).

## Where the seams are (design note for auditors)

- **Persist**: the persisted assistant text is the node's resolved value
  (`streamModelCall` accumulator → `NodeRunSuccess.value` → interpreter sink outputs →
  `SettlementRequest.outputs` → `createChatSettlementCommit`). Reasoning deltas were
  emitted to the stream but never accumulated anywhere server-side, so the ONLY point
  that can compose (reasoning, answer) for persist is the accumulator in
  `model-call-execution.ts`. Serialization there covers plain turns, multi-model
  fan-out branches (each branch's own value), smartModel answers, and aborted
  partials uniformly. o-series falls out naturally: no reasoning text ⇒
  `serializeReasoningText('', answer)` returns the answer verbatim (pinned in shared
  T3 tests and re-pinned here).
- **History strip**: both "sources" (rows the client decrypted and resent — E2EE means
  the server never loads plaintext rows itself — and the client's live-accumulated
  optimistic history; verified: the ONLY provider-messages construction is
  `toHistoryMessages(request.history)` in language-adapter.ts:449, and the only
  executor entry is room-core.ts:553 passing `body.history`) converge on
  `RunStartBody.history` → `executor.start`. The strip sits in chat's
  `prepareStartRequest`, which every start passes (runtime.ts `start()` calls it
  unconditionally). Stripping upstream of the engine also cleans the smartModel
  classifier's `latestAssistantMessage(ctx.history)` prompt — an adapter-level strip
  would have missed it.

## Tests added (name — behavior — criterion)

history-replay.test.ts (all fixtures built via `serializeReasoningText` — G7, no
literal delimiters):

- strips embedded reasoning from an assistant turn resent from a persisted row —
  source 1 (server-loaded row resent by client) — history-strip criterion.
- strips … live-accumulated assistant turn (client optimistic form) — source 2 —
  history-strip criterion.
- strips every reasoning-bearing assistant turn in a multi-turn regenerate history —
  regeneration path shape.
- leaves a user turn verbatim even when its text begins like a delimiter — parser
  never applied to user text.
- returns the very same array when no assistant turn embeds reasoning — identity.
- drops an assistant turn that stripped to nothing — reasoning-only partial replay.
- handles an empty history without inventing entries.

runtime.test.ts:

- strips embedded reasoning from resent assistant history before the run starts —
  wiring pin (text path).
- strips history for a media run too — wiring pin (mint path).
- returns the very same request when the resent history embeds no reasoning —
  untouched-request identity preserved.

model-call-execution.test.ts:

- embeds accumulated reasoning ahead of the answer in the canonical inline format —
  persist criterion (reasoning arrived).
- resolves the answer verbatim when no reasoning text streamed — else-verbatim.
- resolves the answer verbatim when reasoning arrives as token counts only (o-series)
  — o-series criterion (also pins reasoningTokens still recorded in billing).
- settles a reasoning-only aborted partial as billable content — partial-settle
  doctrine interaction.
- embeds reasoning into an aborted partial that streamed both reasoning and text.
- prefers accumulated media over reasoning-bearing text on a media call — media path
  unchanged.

settlement-storage.test.ts:

- counts the stored field as-is when the answer embeds reasoning (no special casing)
  — R2 settlement criterion. NOTE: this is a doctrine PIN, not TDD'd new behavior — it
  passed first run because no special casing exists to remove; declared here honestly.

"Provider messages without it" evidence chain (end-to-end unit pins, no single e2e
test possible — mock provider ignores history): my prepareStartRequest pins →
interpreter.test.ts:2322 "hands the start request history to every node execution
context" (existing) → model-call-execution.test.ts:849 "threads the context history
onto the inference request" (existing) → language-adapter.test.ts:1071 "orders messages
system → history → current user" (existing, verbatim mapping).

## Self-gate

- `vitest run history-replay.test.ts` — pass (7/7). RED verified first: 4 strip
  behaviors failed against identity stub.
- `vitest run runtime.test.ts` — pass (49/49). RED verified: 2 wiring tests failed
  before the `prepareStartRequest` edit.
- `vitest run model-call-execution.test.ts` — pass (67/67). RED verified: 3 new
  behaviors failed before the accumulator edit (reasoning-only abort failed as err —
  the exact current-behavior reason).
- `vitest run settlement-storage.test.ts` — pass (5/5; pin passed first run, see
  above).
- `vitest run runtime.integration.test.ts settlement.integration.test.ts` — pass
  (87/87).
- `vitest run src/slices/workflows` — pass (409 passed, 2 skipped).
- `eslint <all 7 touched files>` from `apps/api/` after final edit — exit 0.
- `tsc --noEmit` (apps/api) — 1 error, FOREIGN: `turn-definition.ts:329` `Property
  'effort' does not exist on type '{ effort: string } | { enabled: false }'` — T16's
  concurrent hard-off union landing against a file I'm forbidden to touch and did not
  touch (nothing I changed feeds that type; my edits import only
  parse/serializeReasoningText).
- `pnpm test:api` (full, coverage; `ps aux | grep vitest` clean before start) — first
  run: all suites executed, exit 1 SOLELY on the recorded §Known-foreign-failures
  branch-coverage gate: `smart-model-execution.ts 94.73% < 95%` (foreign uncommitted
  diff, T7 inherits). Second confirming run (captured to scratchpad
  `test-api-final.log`): **432 test files passed | 3 skipped, zero test failures**;
  `history-replay.test.ts (7 tests)` green in-suite; exit 1 again SOLELY on the same
  recorded foreign coverage error (both ERROR lines name smart-model-execution.ts and
  nothing else). My files' coverage:
  `history-replay.ts` 100/100/100/100; `runtime.ts` and `model-call-execution.ts` both
  above threshold (model-call-execution 100 stmt / 98.67 branch; the uncovered branch
  632-633 is the pre-existing context_length/network mapping, not my lines).

## Acceptance criteria

- final assistant text = T3-serialized (reasoning, answer) when reasoning arrived —
  MET (accumulator + `textValueOf`; pinned success + abort paths).
- else answer verbatim; o-series persists answer only — MET (serializer's empty-
  reasoning identity; o-series pin with reasoningTokens=7).
- no schema migration — MET (no db change anywhere).
- history replay strips reasoning via shared parser, covering BOTH sources; prior turn
  with embedded reasoning produces provider messages without it — MET (strip at the
  single executor-entry seam; both-source tests; four-link pin chain to the adapter's
  message assembly).
- settlement char-counts operate on stored field as-is — MET (no code change needed;
  doctrine pin added).

## Deviations (with reasons)

1. **Persist seam file is `apps/api/src/slices/workflows/nodes/model-call-execution.ts`,
   outside the plan's T6 Files glob (`apps/api/src/slices/chat/**`).** Reasoning deltas
   exist only in the engine's event stream; no chat-slice code ever sees them (chat's
   settlement receives already-final output values). Composing the value anywhere else
   (e.g. re-correlating stream frames to output keys in the chat runtime) would be
   fragile and wrong under fan-out. Additive edit to a file carrying a foreign diff;
   my exact lines listed above.
2. **History strip seam is `prepareStartRequest` (chat runtime), not the adapter's
   `toHistoryMessages`** ("the existing history-build seam" in G8's wording). The
   adapter is T16-owned (out of my bounds) AND an adapter-level strip would miss the
   smartModel classifier's history read. Upstream strip is strictly stronger and
   chat-owned.
3. Reasoning-only assistant history entries are DROPPED at strip (not sent as empty
   messages): `ChatHistoryMessage.content` has `.min(1)` and empty assistant content
   is provider-hostile. Judgment call, documented in code.

## Concerns and limitations

- **Classifier value change (for T7):** `streamModelCall` is shared with smartModel's
  classifier generation. If a classifier's model ever streams reasoning deltas
  (previously silently dropped), its resolved value now carries the canonical inline
  prefix and `resolveClassifierOutput` would need to parse `.answer` first. Not
  reachable with the mock (emits reasoning only under reasoning config, which
  classifier calls never carry) and unlikely with real cheap classifier models, but it
  is a genuine behavior delta inside T7's file ownership — raised to the orchestrator.
- Downstream graph consumers of a modelCall's text value (transform nodes, reducers in
  future multi-node definitions) now see the serialized form, not the bare answer.
  Today's chat/multi-model/smartModel definitions persist those values directly (which
  is exactly the doctrine), but a future definition wanting answer-only mid-flow must
  parse via the shared module.
- The unclosed-delimiter (streaming-partial) history form is untestable without
  writing literal delimiters (G7): both canonical writers (server persist, T8 client
  accumulation) always emit the closed form, and the shared parser's unclosed-form
  tolerance is pinned in T3's own tests — the strip inherits it through
  `parseReasoningText`.
- The settlement char-count pin passed without a red phase (it pins absence of special
  casing, not new behavior).

## Confidence

high — every new behavior watched red then green; the two seams are single choke
points verified by repo-wide grep (`executor.start`, `toHistoryMessages`); all
failures in the final gate attribute to recorded foreign items with file-level
evidence.
