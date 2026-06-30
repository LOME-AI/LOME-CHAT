# Grounding deltas (T0.0)

Three recently-landed behavior changes that the redesign must not regress. Each was
inspected via `git show` this session — all facts **Verified** against the cited commits
and the current working tree.

## (a) cd1737a — empty `length`-finish is billable truncation, NOT an error

Commit `cd1737af43b151fb464098bc79fdc59f785dac19` ("streaming fix", 2026-06-08), touching
`apps/api/src/services/ai/real.ts` (+ tests in `real.test.ts`).

Before: any completed text turn with no visible text threw
(`noTextError`) regardless of finish reason. After: `throwForEmptyTurn(sawText,
toolError, finishReason)` implements this decision table (current code at
`apps/api/src/services/ai/real.ts`, function `throwForEmptyTurn`):

1. `sawText === true` → no-op (normal turn).
2. else if a tool error was held → throw the **original** tool error (preserved for `classifyStreamErrorCode`).
3. else if `finishReason === 'length'` → **return normally**: the model hit its output-token budget before emitting visible text. The caller yields the terminal `finish` event; the turn is a **valid, billable terminal state** (ordinary truncation), persisted and charged like any completion.
4. else (tool-call exhaustion, content filter, bare stop, unknown) → throw `Model returned no text (finishReason: …)`.

Spec consequence for v2: a stream that ends `length` with zero text **must persist and
bill**, not surface an error to the user. Test evidence: `apps/api/src/services/ai/real.test.ts`
(30 added lines in the commit cover the `length` no-throw path).

## (b) f79d690 — tool-error / stream-error recovery semantics

Commit `f79d6909202931d27659a452f190483d51773c8a` ("many bug fixe", 2026-06-07). The
relevant portion is the rewrite of the `fullStream` consumption loop in
`apps/api/src/services/ai/real.ts` (AI SDK v6 surfaces stream and tool failures as
**data parts** on `fullStream` rather than throwing):

- `error` part → **throw immediately** via `asInferenceError` (preserves an `Error` instance's `name`/`status` so `classifyStreamErrorCode` buckets correctly; wraps strings; generic fallback otherwise).
- `abort` part → throw `abortError(reason)`.
- `tool-error` part → **NOT fatal**: held in `toolError` (wrapped in an object so an `undefined` payload is distinguishable from "no tool error") and the loop continues — with `stopWhen`, the model can recover from a failed tool call (e.g. failed search) and still answer on a later step. The held error is surfaced **only if the turn ends with no text**.
- `finish` part → finish reason recorded; after the loop, an empty turn goes through the decision table in delta (a).

Without the rethrow, failures surfaced as the generic "No content generated" fallback
instead of a real classified error. The same commit also added the per-request mock
config assembly `buildMockConfig` (`apps/api/src/services/ai/index.ts`) with
`LOCAL_DEV_MEDIA_DELAY_MS = 3000` / text 60 ms typewriter — dev-server-only affordances
(`isDevServer`), never active under vitest/E2E/CI/production, with per-request
`x-mock-*` overrides winning (see delta (c)).

Spec consequence for v2: the gateway adapter must (1) rethrow stream `error`/`abort`
parts as classified errors, (2) treat tool errors as recoverable-until-turn-end, (3)
attribute an empty failed turn to the held tool error, not a generic message.

## (c) the `x-mock-*` per-request header seam

Today's e2e determinism rides on per-request mock resolution. Named, owned, and
preserved per BACKEND-REDESIGN §19 (owned by T4.3/T4.6 in v2; dev/CI only, stripped at
the edge in production).

**Server side** — `aiClientMiddleware` in
`apps/api/src/middleware/dependencies.ts:143-181` decodes four headers into
`MockAIClientConfig` and passes them to `getAIClient` per request:

| Header | Effect | Source |
| --- | --- | --- |
| `x-mock-classifier-resolution` | forces the mock classifier to resolve to a given model id | `dependencies.ts:153-156` |
| `x-mock-classifier-failure: true` | makes the mock classifier throw (exercises fallback) | `dependencies.ts:157-159` |
| `x-mock-failing-models` | comma-separated model ids whose mock streams fail (partial-failure tests) | `dependencies.ts:160-169` |
| `x-mock-classifier-delay-ms` | positive integer delay before classifier resolution (loading-state tests) | `dependencies.ts:170-176` |

The headers are only consulted in dev/E2E builds — `getAIClient` forks on env, so
production reads are ignored at the env fork (`dependencies.ts:149-151`,
`apps/api/src/services/ai/index.ts:94-105`). The config type documents the seam at
`apps/api/src/services/ai/types.ts:173-174`; the mock client consumes it
(`apps/api/src/services/ai/mock.ts:497`).

**Client side (e2e)** — Verified usage counts across `e2e/**`:
`x-mock-failing-models` ×5 and `x-mock-classifier-resolution` ×5 in
`e2e/chat/multi-model-media.spec.ts`, `e2e/chat/smart-model.spec.ts`,
`e2e/chat/multi-model.spec.ts`, `e2e/chat/regeneration.spec.ts`;
`x-mock-classifier-failure` ×1 in `e2e/chat/smart-model.spec.ts`.

Spec consequence for v2: losing this seam makes Phase-4 re-pointing of the smart-model,
multi-model partial-failure, and media-failure e2e specs silently impossible. v2 must
carry an equivalent per-request mock-resolution mechanism at the `ModelProvider` port,
gated to dev/CI.
