# Task-08 — Smart Model resolved-label + stage-signal wiring — impl-report-1

## Objective

- **RC-2 (web):** `markStageSeen` (apps/web pre-inference-activity store) had zero
  non-test callers, so `data-pre-inference-stages-seen` stayed 0 and the
  smart-model classifier-stage + contracts/signals e2e tests failed. Wire the
  increment at the Smart-tile resolve site.
- **RC-3 (api engine):** the Smart-Model classifier-FAILURE fallback path must
  emit the resolved-model `stream-start` label like the happy path so the
  fallback tile shows chip + nametag. Pin this at the closest api layer.

## Files changed

- `apps/web/src/hooks/chat/use-authenticated-chat.ts` — call
  `usePreInferenceActivityStore.getState().markStageSeen()` at BOTH Smart-tile
  resolve sites: `handleStreamModelResolved` (regenerate/shared path, ~line 492)
  and the inline `onModelResolved` in the send/create stream options (~line 587).
  Both are inside the existing `smartTileIdsRef.current.has(assistantMessageId)`
  guard, so only a Smart tile's resolution advances the counter. Added the store
  import.
- `apps/web/src/hooks/chat/use-authenticated-chat.test.ts` — 3 tests (below) + the
  store import.
- `apps/api/src/slices/workflows/nodes/smart-model-execution.test.ts` — 1 test
  pinning the fallback-path label emission (below).

## Tests added (closest-layer regression proof)

RC-2 (web unit, closest layer):
- `advances the pre-inference stage counter exactly once when the Smart tile
  resolves` — harness fires `onModelResolved` for BOTH a Smart-sentinel tile and
  a plain tile; asserts the counter advances by exactly 1 (only the Smart tile
  counts). Covers AC-1 web half.
- `does not advance the pre-inference stage counter for a plain-model turn` —
  plain single-model turn; asserts the counter is unchanged. Guards over-counting.
- `advances the pre-inference stage counter when the create-flow Smart tile
  resolves` — pins the second resolve site (create flow).

RC-3 (api engine unit, closest layer):
- `labels the classifier-error fallback stream with the resolved fallback model
  id` — classifier throws; asserts the emitted stream begins with
  `{kind:'stream-start', modelId: CHEAP}` (the resolved fallback model) and that
  exactly one stream-start fires. Covers AC-1 api half.

## Where the RC-3 engine fallback label is emitted

`apps/api/src/slices/workflows/nodes/smart-model-execution.ts`. On classifier
failure, `runSmartModel` catches the classifier error (`classifierCall` returns
`{}`), sets `resolvedId = cheapest.id`, and calls `answerCall`, which invokes
`streamModelCall(...)`. `streamModelCall` unconditionally emits
`streamStartEvent(binding.descriptor, request.model)` with the RESOLVED fallback
model (model-call-execution.ts, `streamModelCall`). The label is therefore
already branch-invariant — the happy path and the classifier-failure fallback
path emit the same resolved-model `stream-start` through the same seam.

No new engine change was required for the label: the emission site already
exists in `smart-model-execution.ts` → `answerCall` → `streamModelCall`. My api
test is the regression pin that locks the fallback branch to that behavior. This
is an evidence-based deviation from the plan's premise that the fallback "never
emits the label" (see Deviations); the passing e2e below corroborates it.

## Self-gate

- `pnpm vitest run apps/web/.../use-authenticated-chat.test.ts` — pass (66/66),
  including the 3 new counter tests.
- `pnpm vitest run apps/api/.../smart-model-execution.test.ts` — pass (20/20),
  including the new fallback-label test.
- `turbo typecheck lint --filter=@hushbox/web --filter=@hushbox/api` — exit-0
  (4/4 tasks successful; api:typecheck re-run with `--force` → pass, to defeat
  warm-cache masking).

## TDD verification

- RC-2: wrote the two counter tests first, ran RED (`Expected 1, Received 0` —
  counter stuck at 0, verified against the real store), added the two
  `markStageSeen()` calls → GREEN.
- RC-3: wrote the fallback-label test first; it passed immediately against the
  existing `answerCall`→`streamModelCall` emission. It stands as a regression
  pin, and the finding (label already emitted) is documented above.

## Acceptance criteria

1. **TDD both halves at closest layer** — MET. RC-2: web unit tests RED→GREEN.
   RC-3: api/engine unit test pinning the fallback resolved-model label.
2. **Enforcement rung (dead-producer guard)** — the existing `contracts/signals`
   e2e (rung 3) is the class-killer and already fired. Added Rung-1/2 unit guards
   at the closest layer (the counter-advance / no-advance tests) so a future
   dropped increment fails in unit tests, not only e2e. A generic "exported store
   action with zero production callers fails the build" lint rule is infeasible
   without brittleness: `markStageSeen` is a Zustand store *interface member*, not
   a standalone export, so knip (`lint:unused`) cannot see it; a custom AST rule
   over Zustand `create<>()` action members with test-file exclusion would be a
   speculative single-use rule (CODE-RULES §Simplicity). Justified here in lieu of
   a new lint rule.
3. **Proof e2e** — DEFERRED to the orchestrator's consolidated e2e run (per
   orchestrator instruction; the per-task e2e lock has a ~28-min queue). Evidence
   from my own lock-held run below.

## E2E evidence (deferred to orchestrator; my run's result recorded)

Ran `e2e/chat/smart-model.spec.ts e2e/contracts/signals.spec.ts` under the
exclusive lock (report `e2e/report/2026-07-20T07-53-31`). All three target tests
PASS on every browser project that did not suffer a resource-limit browser crash
(webkit, iphone-15, pixel-7, ipad-pro):
- `Smart Model send runs its pre-inference classifier stage` — PASS (RC-2)
- `pre-inference signal renders and advances on a Smart Model turn` — PASS (RC-2)
- `classifier failure falls back to a value model and still renders a response`
  — PASS (RC-3; chip + nametag render on the fallback branch)

The run's "72 failed" are the chromium + firefox projects failing WHOLESALE (all
their smart-model/signals tests, including known-good ones like "selects Smart
Model … renders cost and Smart chip") from resource exhaustion — 42 browser
crashes, CPU 100%, load 30 on 24 cores. The failure modes are infra, not
assertion: "Target page, context or browser has been closed" and "conversation
creation failed: 404" (stack overload), never a Smart-Model assertion. These are
environmental (concurrent load during the run), which the orchestrator's
serialized consolidated run avoids.

## Deviations

- No new engine/interpreter change for RC-3: the fallback resolved-model label is
  already emitted at `smart-model-execution.ts` (`answerCall` → `streamModelCall`
  → `streamStartEvent`). The plan's premise that the fallback "never emits the
  label" is not borne out by the code — my TDD pin passes immediately and the e2e
  fallback test renders chip + nametag. I pinned the behavior rather than
  fabricate a redundant emission. (Earlier in-progress note speculated a
  settlement `isSmartModel` persistence gap; the passing fallback e2e disproves
  it — withdrawn.)
- I did not touch `interpreter.ts` (Task-13 owns its in-flight
  StorageUnavailableError edit) — no change there was needed.

## Concerns and limitations

- The chromium/firefox e2e failures are shared-infra resource crashes, not
  caused by this task; flagged for the orchestrator's consolidated run.
- `turbo` reported one cache hit for api:typecheck; re-run with `--force` to
  confirm a genuine pass.

## Confidence

High. RC-2: RED→GREEN, isolated, closest-layer, e2e-confirmed on all non-crashed
projects. RC-3: emission site identified in code, TDD-pinned, e2e fallback test
green on all non-crashed projects. Scoped typecheck + lint exit-0.
