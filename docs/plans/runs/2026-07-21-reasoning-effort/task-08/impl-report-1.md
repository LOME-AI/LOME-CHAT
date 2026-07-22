# T8 — Client streaming: reasoning accumulation — impl report 1

## Objective

Reasoning deltas reach client optimistic-message state: `use-authenticated-chat.ts` supplies `onReasoningToken` in both callback sites; deltas accumulate into the same text field via the shared `reasoning-format` module's exported API (delimiters stay module-private); the barrel export line is added per the T8 amendment; no rendering changes.

## Files changed

- `packages/shared/src/index.ts` — added `export * from './reasoning-format.js';` (the amendment's barrel line; T3 landed the module without it).
- `apps/web/src/lib/chat-messages.ts` — generalized `appendTokenToMessage` with a `channel: StreamTokenChannel = 'answer'` parameter (not copied). Answer tokens concatenate verbatim; reasoning tokens fold into the canonical inline format via `parseReasoningText`/`serializeReasoningText` from `@hushbox/shared`.
- `apps/web/src/hooks/chat/use-optimistic-messages.ts` — `updateOptimisticMessageContent` gains an optional `channel` param and now delegates to `appendTokenToMessage` (collapses its previously duplicated inline append — One Implementation, Shared).
- `apps/web/src/hooks/chat/use-authenticated-chat.ts` — supplies `onReasoningToken` in both callback sites: `createOptimisticStreamCallbacks` (existing-conversation optimistic flow → `updateOptimisticMessageContent(id, token, 'reasoning')`) and the hand-written new-chat-flow callbacks (`handleStreamReasoningToken` → `appendTokenToMessage(..., 'reasoning')` on localMessages); added to the create-effect dependency array.
- `apps/web/src/lib/chat-messages.test.ts` — 4 new tests (reasoning embed/accumulate/round-trip/late-reasoning).
- `apps/web/src/hooks/chat/use-optimistic-messages.test.ts` — 1 new test (reasoning channel folds parseably).
- `apps/web/src/hooks/chat/use-authenticated-chat.test.ts` — 2 new tests (reasoning delta reaches the streaming tile in both flows).

## Tests added (name — behavior — criterion)

- chat-messages: `embeds a reasoning-channel token so it parses back as reasoning` — reasoning token on empty content yields `{reasoning, answer:''}` via the shared parser — same-field accumulation.
- chat-messages: `accumulates consecutive reasoning-channel tokens into one reasoning block` — multi-delta accumulation.
- chat-messages: `keeps answer tokens after reasoning identical to the persisted serialization` — live content `===` `serializeReasoningText(reasoning, answer)` at every step — "live and persisted messages parse identically".
- chat-messages: `keeps an existing answer when a late reasoning-channel token arrives` — ordering tolerance.
- use-optimistic-messages: `folds a reasoning-channel token into the parseable reasoning block` — the optimistic store path.
- use-authenticated-chat: `accumulates a reasoning delta into the streaming tile ahead of the answer` — the brief's first red test: a `reasoning-delta` for a bound tile reaches the accumulator through `StreamOptions.onReasoningToken` (failed before wiring: callback undefined, parse yielded no `reasoning`).
- use-authenticated-chat: `accumulates a reasoning delta into the create-flow tile ahead of the answer` — same for the hand-written new-chat-flow callbacks.

TDD: each new test was run and observed failing for the expected reason before the code change (first failure was the missing barrel export — `parseReasoningText is not a function`; after adding the barrel line, failures were behavior-level: reasoning token appended as answer text / `reasoning` absent from parse output).

## Self-gate

- `pnpm test:web` — tests: **359 files / 5867 tests, all pass**; run exits 1 only on a **pre-existing per-file coverage shortfall**: `ERROR: Coverage for branches (87.09%) does not meet global threshold (95%) for src/hooks/models/use-resolve-default-model.ts`. Attribution: that file and its test are committed and unmodified (`git status` clean for `apps/web/src/hooks/models/`); running only its own test file in isolation reproduces the identical 87.09% — the number is fully determined by its own committed tests, so no incidental coverage my change could have removed exists. Outside my ownership; raised.
- `eslint <owned files>` from `apps/web/` and `packages/shared/` after the last edit — pass, zero warnings.
- `pnpm run typecheck` in `packages/shared` — pass.
- `pnpm run typecheck` in `apps/web` — **fails on `../api/src/middleware/pipeline-bindings.ts(59,29): Cannot find name 'ExecutionContext'`** — an `apps/api` file, committed and unmodified, outside my ownership (Workers global type; looks environmental — missing generated worker types — or owned by the concurrent api workstream). Not in T8's scoped checks (`pnpm test:web` only); raised, not fixed.
- `pnpm test:shared` — not run: I did not touch `reasoning-format.ts` (the brief's condition), and `packages/shared` is concurrently owned by T1 mid-flight; the barrel line is proven by shared typecheck passing and by the web suite consuming the exports.

## Acceptance criteria

- `use-authenticated-chat.ts` supplies `onReasoningToken` — **met** (both sites; pinned by the two hook tests).
- Optimistic message accumulates reasoning in the same text field so live and persisted messages parse identically — **met** (round-trip test asserts live content equals the persisted serialization exactly). See deviation on the mechanism.
- `appendTokenToMessage` generalized, not copied — **met** (one function, channel param; the optimistic store's duplicate inline append was collapsed into it).
- First red test: reasoning-delta for a bound tile reaches the accumulator — **met**, watched fail then pass.
- No rendering changes — **met** (no component files touched).
- Amendment: barrel export line added, module consumed through the barrel, delimiters module-private — **met** (no literal `<think>` anywhere outside `reasoning-format.ts`, including tests — tests assert through `parseReasoningText`/`serializeReasoningText`).

## Deviations

- **Streaming-partial mechanism:** the criteria describe "open delimiter on first reasoning token, close on first answer token" (an unclosed mid-stream form). I instead fold each reasoning token via `serializeReasoningText((reasoning ?? '') + token, answer)` — the content is always in closed canonical form — and answer tokens append verbatim. Reasons: (a) the amendment directs adding a new streaming-assembly export **only if** the existing API cannot express the state; it can — closed-form-with-empty-answer parses byte-identically to the unclosed form (`{reasoning, answer:''}`), so live and persisted content parse identically at every step, which is the criterion's purpose; (b) writing an unclosed open tag from web code would require exporting delimiter mechanics (G7 risk); (c) close-on-first-answer-token inferred from content would mis-close text from models that natively emit `<think>` in their **text** deltas — verbatim answer appends preserve those bytes untouched (module header: never rewrites received bytes). No new shared export was needed; `reasoning-format.ts` is untouched.

## Concerns and limitations

- The trial-chat path (`use-trial-chat` / trial store) was not wired — the brief and criteria scope T8 to `use-authenticated-chat.ts`; if trial models can emit reasoning deltas, they still drop there (T10/T11 may surface this).
- Interleaved reasoning-after-answer (never observed from providers) folds the late reasoning to the front of the block — covered by a test, behavior is deliberate.
- My owned files carried unrelated concurrent/uncommitted diffs at task start (fork-chaining in `use-authenticated-chat.ts`, `webSearchEnabled` in `use-chat-stream.ts`, `ModelReasoning` barrel line in `packages/shared/src/index.ts`); I left them untouched and my edits are purely additive around them.

## Confidence

**High** — the full web suite (5867 tests) is green including 7 new behavior tests written red-first; the only gate failures are attributed with evidence to pre-existing, out-of-ownership causes.
